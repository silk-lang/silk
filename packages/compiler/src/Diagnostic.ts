import type * as ConfigurationError from './ConfigurationError.js'
import type * as ProviderSelection from './ProviderSelection.js'
import * as Location from './Location.js'
import type * as SemanticContext from './SemanticContext.js'
import * as SourceSpan from './SourceSpan.js'
import type * as Target from './Target.js'
import * as Token from './Token.js'

/** The compiler phase that originated a diagnostic. */
export type Phase = 'lexical' | 'parser' | 'module' | 'semantic' | 'ownership' | 'layout'

const phaseRank: Readonly<Record<Phase, number>> = {
  lexical: 0,
  parser: 1,
  module: 2,
  semantic: 3,
  ownership: 4,
  layout: 5,
}

/** Stable diagnostic code for a maximal unsupported byte region. */
export const unsupportedBytesCode = 'LEX0001' as const

/** Stable code for an identifier-like modifier outside the closed literal vocabulary. */
export const unknownLiteralModifierCode = 'LEX0002' as const

/** Stable code for a literal whose matching closing delimiter is absent. */
export const unterminatedStaticLiteralCode = 'LEX0003' as const

/** Stable code for an integer-literal base prefix that no digit follows. */
export const missingBaseDigitsCode = 'LEX0004' as const

/** Stable code for a number-literal digit separator outside a position between two digits. */
export const invalidDigitSeparatorCode = 'LEX0005' as const

/** Stable code for a float-literal exponent marker that no exponent digit follows. */
export const missingExponentDigitsCode = 'LEX0006' as const

/** Stable code for a character literal that denotes a number of scalars other than one. */
export const characterLiteralScalarCountCode = 'LEX0007' as const

/** Stable code for a duration component amount that is not a whole decimal integer. */
export const invalidDurationAmountCode = 'LEX0008' as const

/** Stable code for an identifier-like suffix outside the duration unit vocabulary. */
export const unknownDurationUnitCode = 'LEX0009' as const

/** Stable code for a duration unit repeated within one compact literal. */
export const repeatedDurationUnitCode = 'LEX0010' as const

/** Stable code for duration components that do not descend from larger to smaller units. */
export const outOfOrderDurationUnitCode = 'LEX0011' as const

/** Stable code for a subordinate duration component outside its canonical field bound. */
export const subordinateDurationOutOfRangeCode = 'LEX0012' as const

/** Stable code for one required token that is absent at its insertion position. */
export const missingTokenCode = 'PAR0001' as const

/** Stable code for one maximal region of unexpected concrete tokens. */
export const unexpectedTokensCode = 'PAR0002' as const

/** Stable code for a primary-expression template start reserved for future support. */
export const reservedTemplateSyntaxCode = 'PAR0003' as const

/** Stable code for an import whose reserved final path segment cannot form an implicit binding. */
export const reservedImportBindingCode = 'PAR0004' as const
/** Stable code for an expression child beyond the parser's supported nesting depth. */
export const expressionNestingLimitExceededCode = 'PAR0005' as const

/** Stable code for an import naming a module absent from the supplied sources. */
export const unknownModuleCode = 'MOD0001' as const

/** Stable code for an import redundantly naming its own containing module. */
export const selfImportCode = 'MOD0002' as const

/** Stable code for a present return-type name that is not a bootstrap built-in. */
export const unknownTypeCode = 'SEM0001' as const

/** Stable code for a literal outside its selected integer range. */
export const integerOutOfRangeCode = 'SEM0002' as const

/** Stable code for a present declaration name repeated after its first occurrence. */
export const duplicateDeclarationNameCode = 'SEM0003' as const

/** Stable code for a present call name with no matching top-level declaration. */
export const unknownFunctionCode = 'SEM0004' as const

/** Stable code for a present parameter name repeated after its first occurrence. */
export const duplicateParameterNameCode = 'SEM0005' as const

/** Stable code for a present value name with no matching local declaration. */
export const unknownValueReferenceCode = 'SEM0006' as const

/** Stable code for a uniquely resolved call with the wrong number of arguments. */
export const wrongCallArityCode = 'SEM0007' as const

/** Stable code for a binding whose name repeats a parameter or an earlier binding. */
export const rebindingNameCode = 'SEM0008' as const

/** Stable code for a qualified call naming an unknown built-in actor. */
export const unknownActorCode = 'SEM0009' as const

/** Stable code for a known actor called with an unknown operation name. */
export const unknownActorOperationCode = 'SEM0010' as const

/** Stable code for a conditional whose condition is not `bool`. */
export const conditionNotBoolCode = 'SEM0011' as const

/** Stable code for a call argument whose type mismatches its parameter. */
export const argumentTypeMismatchCode = 'SEM0012' as const
export const unknownImportedMemberCode = 'SEM0014' as const
export const inaccessibleImportedMemberCode = 'SEM0015' as const
export const bindingConflictCode = 'SEM0016' as const
export const duplicateFieldNameCode = 'SEM0017' as const
export const expectedTypeCode = 'SEM0018' as const
export const privateTypeExposureCode = 'SEM0019' as const
export const inlineRecursiveAggregateCode = 'SEM0020' as const
export const inaccessibleStructConstructionCode = 'SEM0021' as const
export const unknownStructFieldCode = 'SEM0022' as const
export const duplicateStructInitializerCode = 'SEM0023' as const
export const missingStructInitializerCode = 'SEM0024' as const
export const structFieldTypeMismatchCode = 'SEM0025' as const
export const projectionOnNonStructCode = 'SEM0026' as const
export const unknownProjectedFieldCode = 'SEM0027' as const
export const inaccessibleProjectedFieldCode = 'SEM0028' as const
export const emptyArrayNeedsContextCode = 'SEM0029' as const
export const arrayElementTypeMismatchCode = 'SEM0030' as const
export const arrayLengthMismatchCode = 'SEM0031' as const
export const indexOnNonArrayCode = 'SEM0032' as const
export const indexNotUsizeCode = 'SEM0033' as const
export const indexOutOfBoundsCode = 'SEM0034' as const
export const immutableAssignmentCode = 'SEM0035' as const
export const invalidAssignmentPlaceCode = 'SEM0036' as const
export const assignmentTypeMismatchCode = 'SEM0037' as const
export const transferOutsideLoopCode = 'SEM0038' as const
export const invalidUnionMemberCode = 'SEM0039' as const
export const incompatibleUnionConversionCode = 'SEM0040' as const
export const matchScrutineeNotNominalCode = 'SEM0041' as const
export const matchMemberNotInScrutineeCode = 'SEM0042' as const
export const unreachableMatchArmCode = 'SEM0043' as const
export const incompleteMatchCode = 'SEM0044' as const
export const matchGuardNotBoolCode = 'SEM0045' as const
export const missingPatternFieldCode = 'SEM0046' as const
export const duplicatePatternFieldCode = 'SEM0047' as const
export const patternBindingConflictCode = 'SEM0048' as const
export const incompatibleMatchResultsCode = 'SEM0049' as const
export const duplicateTypeParameterCode = 'SEM0050' as const
export const typeArgumentArityCode = 'SEM0051' as const
export const typeArgumentInferenceCode = 'SEM0052' as const
export const polymorphicRecursionCode = 'SEM0053' as const
/** Stable code for an operand that cannot form a borrowed view. */
export const invalidBorrowOperandCode = 'SEM0056' as const
export const exclusiveBorrowRequiresMutableCode = 'SEM0057' as const
export const invalidSliceReborrowCode = 'SEM0058' as const
export const implicitSliceDecayCode = 'SEM0059' as const
/** Stable code for a negative decimal literal contextualized as unsigned `usize`. */
export const usizeNegativeCode = 'SEM0060' as const
/** Stable code for a type that cannot inhabit an Effect failure channel. */
export const invalidFailureTypeCode = 'SEM0061' as const
/** Stable code for a failure channel attached to an ordinary function. */
export const failureChannelOnOrdinaryCode = 'SEM0062' as const
export const failOutsideEffectCode = 'SEM0063' as const
export const undeclaredFailureCode = 'SEM0064' as const
export const runNonEffectCode = 'SEM0065' as const
export const unhandledEffectFailuresCode = 'SEM0066' as const
export const invalidEffectHandlerCode = 'SEM0067' as const
export const mutableEffectRecipeCode = 'SEM0068' as const
/** Stable code for a non-concrete or non-nominal capability in a requirement row. */
export const invalidRequirementTypeCode = 'SEM0070' as const
export const unhandledEffectRequirementsCode = 'SEM0071' as const
export const invalidEffectProvisionCode = 'SEM0074' as const
export const nonCallableApplicationCode = 'SEM0075' as const
export const incompatibleCallableSignatureCode = 'SEM0076' as const
export const invalidCallableInvocationAccessCode = 'SEM0077' as const
export const redundantUnaryEmptyCallCode = 'SEM0078' as const
export const callableIdentityErasureCode = 'SEM0080' as const
export const unknownOwnedCallableReturnCode = 'SEM0081' as const
/** Stable code for an Effect join whose alternatives cannot be represented as a finite composite. */
export const nonFiniteEffectJoinCode = 'SEM0132' as const
/** Stable code for a refutable pattern in an unconditional local binding. */
export const refutableLetPatternCode = 'SEM0133' as const
/** Stable code for an operator marker that cannot describe its interface operation. */
export const invalidOperatorContractCode = 'SEM0134' as const
/** Stable code for operator syntax with no marked operation accepting its operands. */
export const operatorNotApplicableCode = 'SEM0135' as const
/** Stable code for operator syntax matched by more than one marked operation. */
export const ambiguousOperatorCode = 'SEM0136' as const
/** Stable code for an unsafe acknowledgement that does not complete an unsafe invocation. */
export const misplacedUnsafeAcknowledgementCode = 'SEM0137' as const
/** Stable code for a statically known allocation/layout specialization mismatch. */
export const localSharedLayoutMismatchCode = 'SEM0138' as const
/** Stable code for a concrete executable that fails one sealed static-property obligation. */
export const unsatisfiedExecutablePropertyCode = 'SEM0139' as const
/** Stable code for an ordinary capability conjoined with one exact executable bound. */
export const invalidExecutablePropertyConjunctCode = 'SEM0141' as const
/** Stable code for a statically known execution-package allocation/layout mismatch. */
export const executionLayoutMismatchCode = 'SEM0142' as const
/** Stable code for `mut` where no mutable owned parameter storage exists. */
export const invalidMutableParameterCode = 'SEM0143' as const
/** Stable code for mutating an outer callable from a deferred effect recipe. */
export const deferredCallableMutationCode = 'SEM0145' as const
/** Stable code for a scalar enum with no declared members. */
export const emptyEnumCode = 'SEM0146' as const
/** Stable code for a scalar enum representation outside the fixed-width integer set. */
export const unsupportedEnumRepresentationCode = 'SEM0147' as const
/** Stable code for a scalar enum member name repeated after its first declaration. */
export const duplicateEnumMemberNameCode = 'SEM0148' as const
/** Stable code for a scalar enum discriminant repeated after its first declaration. */
export const duplicateEnumDiscriminantCode = 'SEM0149' as const
/** Stable code for an explicit scalar enum discriminant outside its representation range. */
export const enumDiscriminantOutOfRangeCode = 'SEM0150' as const
/** Stable code for an implicit scalar enum successor outside its representation range. */
export const enumImplicitDiscriminantOverflowCode = 'SEM0151' as const
/** Stable code for a negative discriminant under an unsigned scalar enum representation. */
export const unsignedEnumNegativeDiscriminantCode = 'SEM0152' as const
/** Stable code for a member missing from a resolved scalar enum. */
export const unknownEnumMemberCode = 'SEM0153' as const
/** Stable code for a canonical member used through or required by another enum. */
export const wrongEnumMemberCode = 'SEM0154' as const
/** Stable code for implicit mixing between a scalar enum and an integer. */
export const enumIntegerMismatchCode = 'SEM0155' as const
/** Stable code for equality between distinct canonical scalar enums. */
export const crossEnumEqualityCode = 'SEM0156' as const
/** Stable code for direct ordering of scalar enum values. */
export const enumOrderingCode = 'SEM0157' as const
/** Stable code for a scalar enum match that leaves canonical members uncovered. */
export const incompleteEnumMatchCode = 'SEM0158' as const
/** Stable code for a repeated unguarded scalar enum member arm. */
export const duplicateEnumMatchArmCode = 'SEM0159' as const
/** Stable code for a scalar enum arm following an unguarded wildcard. */
export const enumMatchArmAfterWildcardCode = 'SEM0160' as const
/** Stable code for a scalar enum pattern naming a member of another enum. */
export const foreignEnumPatternCode = 'SEM0161' as const
/** Stable code for an integer literal pattern used against a scalar enum. */
export const integerPatternAgainstEnumCode = 'SEM0162' as const
/** Stable code for a raw storage operation outside lexical unsafe authority. */
export const missingUnsafeBoundaryCode = 'SEM0082' as const
/** Stable code for an invalid source-declared capability implementation. */
export const invalidConformanceCode = 'SEM0083' as const
/** Stable code for a Drop implementation outside the compiler-sealed hook contract. */
export const invalidDropHookCode = 'SEM0084' as const
/** Stable code for malformed escapes, invalid UTF-8, or non-byte literal values. */
export const invalidStaticLiteralCode = 'SEM0085' as const
/** Stable code for a typed constant whose type or literal is outside the constant contract. */
export const invalidConstantCode = 'SEM0086' as const
/** Stable code for rejected profile inputs, package schemas, defaults, or predicates. */
export const invalidConfigurationCode = 'SEM0214' as const
/** Stable code for invalid raw-pointer alignment, address space, or qualifier conversion. */
export const invalidPointerQualifierCode = 'SEM0215' as const
/** A diagnostic observer callback lacks a complete direct-execution proof. */
export const invalidDiagnosticObserverCode = 'SEM0216' as const
/** Terminal observation is provably outside a selected failure handler. */
export const missingDiagnosticContextCode = 'SEM0217' as const
/** Stable code for an expression statement whose result cannot be intentionally ignored. */
export const expressionStatementResultCode = 'SEM0087' as const
/** Stable code for using a generic binder in a value, failure-row, or requirement-row position of another kind. */
export const genericParameterKindMismatchCode = 'SEM0088' as const
/** Stable code for a failure or requirement row that cannot be finitely decomposed. */
export const contractRowInferenceCode = 'SEM0089' as const
/** Stable code for storage, bodies, or defaults inside a source service contract. */
export const invalidServiceDeclarationCode = 'SEM0090' as const
/** Stable code for one reachable intrinsic unavailable on the requested execution target. */
export const intrinsicTargetUnavailableCode = 'SEM0093' as const
/** Stable code for a float literal spelling no floating-point value can represent. */
export const invalidFloatLiteralCode = 'SEM0095' as const
/** Stable code for a bound operation call whose receiver names more than one bounded parameter. */
export const ambiguousBoundOperationCode = 'SEM0097' as const
/** Stable code for one named type parameter left undetermined by an explicit prefix and the arguments. */
export const uninferredTypeParameterCode = 'SEM0099' as const
/** Stable code for an explicit type argument contradicting the type its value arguments imply. */
export const typeArgumentConflictCode = 'SEM0100' as const

/** Stable code for a bound operation whose selected witness has no lowering. */
export const unlowerableBoundWitnessCode = 'SEM0101' as const

/** Stable code for constructing an aggregate that stores a bare callable value. */
export const storedCallableConstructionCode = 'SEM0103' as const
/** Stable code for the first struct initializer that contradicts an inferred representation. */
export const conflictingInitializerRepresentationCode = 'SEM0104' as const
/** Stable code for the first exact representation that diverges at a static value join. */
export const divergentRepresentationJoinCode = 'SEM0105' as const
/** Stable code for a representation argument whose contract cannot satisfy its required bound. */
export const incompatibleRepresentationBoundCode = 'SEM0106' as const
/** Stable code for storing a represented Effect before its runtime layout is supported. */
export const storedRepresentedEffectConstructionCode = 'SEM0107' as const
/** Stable code for two conformance heads that may name one provider under one interface. */
export const overlappingConformanceCode = 'SEM0119' as const
/** Stable code for a conformance requirement that does not descend toward a base witness. */
export const nonTerminatingConformanceCode = 'SEM0120' as const
/** Stable code for a concrete specialization whose conditional requirements cannot be proved. */
export const unprovenConformanceCode = 'SEM0121' as const
/** Stable code for a complete application that reaches the instance frontier with open rows or evidence. */
export const nonConcreteSpecializationCode = 'SEM0122' as const
/** Stable code for a provider that matches no member of its concrete source requirement row. */
export const providerNoMatchCode = 'SEM0123' as const
/** Stable code for provider relations sharing a selector but retaining disjoint candidate sets. */
export const jointProviderSelectionConflictCode = 'SEM0124' as const
/** Stable code for provider selection that retains more than one common requirement member. */
export const providerAmbiguityCode = 'SEM0125' as const
/** Stable code for an explicitly or independently selected row that is not exactly one member. */
export const selectedRowCardinalityCode = 'SEM0126' as const
/** Stable code for a surviving provider candidate with more than one conformance witness. */
export const providerConformanceAmbiguityCode = 'SEM0127' as const
/** Stable code for a surviving provider candidate whose conformance mapping is invalid. */
export const invalidProviderConformanceCode = 'SEM0128' as const
/** Stable code for an explicit return whose value violates the declaration result. */
export const returnTypeMismatchCode = 'SEM0129' as const
/** Stable code for a reachable non-unit function fallthrough. */
export const missingReturnCode = 'SEM0130' as const
/** Stable code for a provider whose key matches but whose access cannot satisfy the requirement. */
export const providerAccessMismatchCode = 'SEM0131' as const
/** Stable code for a `typeof` item that resolves to no declaration in scope. */
export const unresolvedExactRepresentationItemCode = 'SEM0108' as const
/** Stable code for a `typeof` item whose name belongs to more than one declaration. */
export const ambiguousExactRepresentationItemCode = 'SEM0109' as const
/** Stable code for a `typeof` item that names something other than an ordinary callable. */
export const uncallableExactRepresentationItemCode = 'SEM0110' as const
/** Stable code for a `typeof` item whose generic parameters are not all supplied. */
export const openExactRepresentationItemCode = 'SEM0111' as const
/** Stable code for a public contract exposing the exact identity of a private item. */
export const privateExactRepresentationLeakCode = 'SEM0112' as const
/** Stable code for one opaque producer specialization yielding multiple exact identities. */
export const divergentOpaqueRealizationCode = 'SEM0113' as const
/** Stable code for an opaque family whose representation evidence contains no local construction. */
export const opaqueRealizationCycleCode = 'SEM0114' as const
/** Stable code for an opaque realization whose inline captures contain that same family. */
export const inlineOpaqueLayoutCycleCode = 'SEM0115' as const
/** Stable code for an opaque result binder whose bound is not callable or Effect representation. */
export const invalidOpaqueResultBinderCode = 'SEM0116' as const
/** Stable code for an opaque producer whose reachable returns establish no representation. */
export const missingOpaqueRealizationCode = 'SEM0117' as const
/** Stable code for an opaque result declared where no producer body can establish its identity. */
export const bodylessOpaqueResultCode = 'SEM0118' as const

/** Stable code for effect-block return sites whose success types disagree. */
export const effectBlockReturnMismatchCode = 'SEM0163' as const
/** Stable code for a nominal union declaration with no variants. */
export const emptyNominalUnionCode = 'SEM0164' as const
/** Stable code for a repeated variant name within one nominal union. */
export const duplicateUnionVariantCode = 'SEM0165' as const
/** Stable code for a named-field variant whose braces contain no field. */
export const emptyUnionVariantCode = 'SEM0166' as const
/** Stable code for a variant selector absent from its resolved nominal union. */
export const unknownUnionVariantCode = 'SEM0167' as const
/** Stable code for a variant qualifier that does not name a nominal union. */
export const expectedNominalUnionCode = 'SEM0168' as const
/** Stable code for construction through an incomplete nominal union declaration. */
export const invalidNominalUnionConstructionCode = 'SEM0169' as const

/** Stable code for a duration literal whose exact nanosecond total exceeds `u64`. */
export const durationOutOfRangeCode = 'SEM0170' as const
/** Stable code for postfix referent projection whose subject is not a reference. */
export const invalidReferentProjectionCode = 'SEM0171' as const

/** Stable code for positional construction with the wrong number of tuple elements. */
export const tupleArityMismatchCode = 'SEM0172' as const

/** Stable code for using tuple syntax with a named struct or record syntax with a tuple. */
export const contextualAggregateKindMismatchCode = 'SEM0173' as const

/** Stable code for attempting to join distinct anonymous aggregate occurrences. */
export const anonymousAggregateJoinMismatchCode = 'SEM0174' as const

/** Stable code for attempting named-field construction of a positional aggregate. */
export const positionalFieldConstructionCode = 'SEM0175' as const

/** Stable code for crossing from static evaluation into unavailable runtime work. */
export const staticPhaseViolationCode = 'SEM0176' as const
/** Stable code for a selected source-requested compile failure. */
export const selectedCompileErrorCode = 'SEM0177' as const
/** Stable code for a cycle in one demanded static application. */
export const staticEvaluationCycleCode = 'SEM0178' as const
/** Stable code for exhausting the static evaluator's deterministic step budget. */
export const staticStepLimitCode = 'SEM0179' as const
/** Stable code for exhausting the static evaluator's logical call-depth budget. */
export const staticCallDepthLimitCode = 'SEM0180' as const
/** Stable code for exhausting the static evaluator's retained-value budget. */
export const staticRetainedValueLimitCode = 'SEM0181' as const
/** Stable code for exhausting the static evaluator's residual-growth budget. */
export const staticResidualGrowthLimitCode = 'SEM0182' as const
/** Stable code for a type alias whose target resolves back through the alias itself. */
export const cyclicTypeAliasCode = 'SEM0183' as const
/** Stable code for a type alias that declares type parameters. */
export const typeAliasParametersCode = 'SEM0184' as const
/** Stable code for a foreign function whose ABI string is not "C". */
export const unsupportedForeignAbiCode = 'SEM0185' as const
/** Stable code for a foreign function declared without the mandatory unsafe qualifier. */
export const foreignFunctionRequiresUnsafeCode = 'SEM0186' as const
/** Stable code for a foreign parameter or result type outside the C-compatible scalar subset. */
export const foreignTypeNotAdmittedCode = 'SEM0187' as const
/** Stable code for Silk-only contract syntax retained on a foreign function declaration. */
export const foreignDeclarationRestrictionCode = 'SEM0188' as const
/** Stable code for using a foreign function as a first-class value rather than calling it. */
export const foreignFunctionNotFirstClassCode = 'SEM0189' as const
/** Stable code for a native symbol that is not an ASCII identifier. */
export const invalidForeignSymbolCode = 'SEM0190' as const
/** Stable code for a native symbol the compiler reserves for its own runtime or entry. */
export const reservedForeignSymbolCode = 'SEM0191' as const
/** Stable code for two reachable declarations of one symbol with different C signatures. */
export const conflictingForeignSignatureCode = 'SEM0192' as const
/** Stable code for one reachable foreign call unavailable on the requested execution surface. */
export const foreignFunctionTargetUnavailableCode = 'SEM0193' as const
/** Stable code for an inherent impl head that is not the whole family of a module-local nominal. */
export const invalidInherentHeadCode = 'SEM0194' as const
/** Stable code for an inherent impl member that cannot be an associated member. */
export const invalidInherentMemberCode = 'SEM0195' as const
/** Stable code for two inherent members of one owner sharing a name. */
export const duplicateInherentMemberCode = 'SEM0196' as const
/** Stable code for a selective import naming an inherent member as if it were a root declaration. */
export const importedInherentMemberCode = 'SEM0197' as const
/** Stable code for an associated function called on a value as though it had a receiver. */
export const associatedFunctionOnValueCode = 'SEM0198' as const
/** Stable code for nesting one anonymous callable body inside another in the first language slice. */
export const nestedAnonymousCallableCode = 'SEM0199' as const
/** Stable code for a receiver operation declared by more than one bound of one type parameter. */
export const ambiguousReceiverOperationCode = 'SEM0200' as const
/** Stable code for an `export "C"` function whose body may suspend. */
export const exportSuspendsCode = 'SEM0201' as const
/** Stable code for a receiver operation supplied by more than one of the receiver's conformances. */
export const ambiguousSuppliedOperationCode = 'SEM0202' as const
/** Stable code for naming a conformance-supplied receiver operation as a value instead of calling it. */
export const suppliedOperationValueCode = 'SEM0203' as const
/** Stable code for a C-layout record that declares type parameters. */
export const genericCLayoutRecordCode = 'SEM0205' as const
/** Stable code for a C-layout record field outside the closed C object subset. */
export const unsupportedCLayoutFieldCode = 'SEM0206' as const
/** Stable code for a value that cannot become an exact noncapturing C callback address. */
export const invalidForeignCallbackCode = 'SEM0207' as const
/** Stable code for reachable C data on an execution surface without native symbol linkage. */
export const foreignStaticTargetUnavailableCode = 'SEM0208' as const
/** An explicit lifetime does not name a binder in its lexical header scope. */
export const unknownLifetimeCode = 'SEM0209' as const
/** An omitted output region has no unique declaration-level input relationship. */
export const ambiguousLifetimeElisionCode = 'SEM0210' as const
/** A lifetime binder or outlives bound has an unsupported declaration shape. */
export const invalidLifetimeBinderCode = 'SEM0211' as const
export const unsatisfiedLifetimeBoundCode = 'SEM0212' as const
export const unsatisfiedTypeOutlivesCode = 'SEM0213' as const
/** A `test` qualifier marks a function outside the finite executable test contract. */
export const invalidTestDeclarationCode = 'SEM0218' as const
/** Emitted code references a function instance whose valid body native lowering does not support yet. */
export const unsupportedLoweringCode = 'SEM0219' as const
/** A borrowed value is used beyond the validity of its referent. */
export const expiredLifetimeCode = 'OWN0019' as const
/** An owner cannot be preserved by the suspension frame at this run boundary. */
export const invalidSuspensionOwnershipCode = 'OWN0020' as const

/** Stable code for a use of a binding after its consuming move. */
export const useAfterMoveCode = 'OWN0001' as const
export const partialMoveCode = 'OWN0002' as const
export const explicitMoveRequiredCode = 'OWN0003' as const
export const overlappingAssignmentCode = 'OWN0004' as const
export const incompatibleLoopHeaderCode = 'OWN0005' as const
export const matchBorrowEscapeCode = 'OWN0006' as const
export const exclusiveMatchRequiresMutableCode = 'OWN0007' as const
export const guardConsumesPatternCode = 'OWN0008' as const
export const invalidMatchScrutineePlaceCode = 'OWN0009' as const
export const conflictingViewLoanCode = 'OWN0010' as const
export const ownerAccessDuringLoanCode = 'OWN0011' as const
export const borrowedMoveCode = 'OWN0012' as const

/** Stable code for invoking a stored callable through too weak an aggregate receiver access. */
export const storedCallableInvocationAccessCode = 'OWN0014' as const

/** Stable code for running a stored Effect through too weak an aggregate receiver access. */
export const storedEffectRunAccessCode = 'OWN0015' as const
/** Stable code for an access-scoped local-shared borrow escaping or crossing suspension. */
export const localSharedAccessEscapeCode = 'OWN0016' as const
/** Stable code for an owner consumed in only some arms of a branch merge. */
export const incompatibleArmMergeCode = 'OWN0017' as const
/** Stable code for returning a callable or Effect that borrows storage owned by the returning function. */
export const executableBorrowEscapeCode = 'OWN0018' as const

/** Stable code for an exact `usize` or `isize` literal outside the selected target word. */
export const wordLiteralOutOfRangeCode = 'LAY0001' as const

/** Every stable diagnostic code any phase can produce. */
export type Code =
  | typeof unknownLifetimeCode
  | typeof ambiguousLifetimeElisionCode
  | typeof invalidLifetimeBinderCode
  | typeof unsatisfiedLifetimeBoundCode
  | typeof unsatisfiedTypeOutlivesCode
  | typeof invalidTestDeclarationCode
  | typeof unsupportedLoweringCode
  | typeof expiredLifetimeCode
  | typeof invalidSuspensionOwnershipCode
  | typeof unsupportedBytesCode
  | typeof unknownLiteralModifierCode
  | typeof unterminatedStaticLiteralCode
  | typeof missingBaseDigitsCode
  | typeof invalidDigitSeparatorCode
  | typeof missingExponentDigitsCode
  | typeof characterLiteralScalarCountCode
  | typeof invalidDurationAmountCode
  | typeof unknownDurationUnitCode
  | typeof repeatedDurationUnitCode
  | typeof outOfOrderDurationUnitCode
  | typeof subordinateDurationOutOfRangeCode
  | typeof missingTokenCode
  | typeof unexpectedTokensCode
  | typeof reservedTemplateSyntaxCode
  | typeof reservedImportBindingCode
  | typeof expressionNestingLimitExceededCode
  | typeof unknownModuleCode
  | typeof selfImportCode
  | typeof unknownTypeCode
  | typeof integerOutOfRangeCode
  | typeof duplicateDeclarationNameCode
  | typeof unknownFunctionCode
  | typeof duplicateParameterNameCode
  | typeof unknownValueReferenceCode
  | typeof wrongCallArityCode
  | typeof rebindingNameCode
  | typeof unknownActorCode
  | typeof unknownActorOperationCode
  | typeof conditionNotBoolCode
  | typeof argumentTypeMismatchCode
  | typeof unknownImportedMemberCode
  | typeof inaccessibleImportedMemberCode
  | typeof bindingConflictCode
  | typeof duplicateFieldNameCode
  | typeof expectedTypeCode
  | typeof privateTypeExposureCode
  | typeof inlineRecursiveAggregateCode
  | typeof inaccessibleStructConstructionCode
  | typeof unknownStructFieldCode
  | typeof duplicateStructInitializerCode
  | typeof missingStructInitializerCode
  | typeof structFieldTypeMismatchCode
  | typeof projectionOnNonStructCode
  | typeof unknownProjectedFieldCode
  | typeof inaccessibleProjectedFieldCode
  | typeof emptyArrayNeedsContextCode
  | typeof arrayElementTypeMismatchCode
  | typeof arrayLengthMismatchCode
  | typeof indexOnNonArrayCode
  | typeof indexNotUsizeCode
  | typeof indexOutOfBoundsCode
  | typeof immutableAssignmentCode
  | typeof invalidAssignmentPlaceCode
  | typeof assignmentTypeMismatchCode
  | typeof transferOutsideLoopCode
  | typeof invalidUnionMemberCode
  | typeof incompatibleUnionConversionCode
  | typeof matchScrutineeNotNominalCode
  | typeof matchMemberNotInScrutineeCode
  | typeof unreachableMatchArmCode
  | typeof incompleteMatchCode
  | typeof matchGuardNotBoolCode
  | typeof missingPatternFieldCode
  | typeof duplicatePatternFieldCode
  | typeof patternBindingConflictCode
  | typeof incompatibleMatchResultsCode
  | typeof duplicateTypeParameterCode
  | typeof typeArgumentArityCode
  | typeof typeArgumentInferenceCode
  | typeof polymorphicRecursionCode
  | typeof invalidBorrowOperandCode
  | typeof exclusiveBorrowRequiresMutableCode
  | typeof invalidSliceReborrowCode
  | typeof implicitSliceDecayCode
  | typeof usizeNegativeCode
  | typeof invalidFailureTypeCode
  | typeof failureChannelOnOrdinaryCode
  | typeof failOutsideEffectCode
  | typeof undeclaredFailureCode
  | typeof runNonEffectCode
  | typeof unhandledEffectFailuresCode
  | typeof invalidEffectHandlerCode
  | typeof mutableEffectRecipeCode
  | typeof invalidRequirementTypeCode
  | typeof unhandledEffectRequirementsCode
  | typeof invalidEffectProvisionCode
  | typeof nonCallableApplicationCode
  | typeof incompatibleCallableSignatureCode
  | typeof invalidCallableInvocationAccessCode
  | typeof redundantUnaryEmptyCallCode
  | typeof callableIdentityErasureCode
  | typeof unknownOwnedCallableReturnCode
  | typeof nonFiniteEffectJoinCode
  | typeof refutableLetPatternCode
  | typeof invalidOperatorContractCode
  | typeof operatorNotApplicableCode
  | typeof ambiguousOperatorCode
  | typeof misplacedUnsafeAcknowledgementCode
  | typeof localSharedLayoutMismatchCode
  | typeof unsatisfiedExecutablePropertyCode
  | typeof invalidExecutablePropertyConjunctCode
  | typeof executionLayoutMismatchCode
  | typeof invalidMutableParameterCode
  | typeof deferredCallableMutationCode
  | typeof emptyEnumCode
  | typeof unsupportedEnumRepresentationCode
  | typeof duplicateEnumMemberNameCode
  | typeof duplicateEnumDiscriminantCode
  | typeof enumDiscriminantOutOfRangeCode
  | typeof enumImplicitDiscriminantOverflowCode
  | typeof unsignedEnumNegativeDiscriminantCode
  | typeof unknownEnumMemberCode
  | typeof wrongEnumMemberCode
  | typeof enumIntegerMismatchCode
  | typeof crossEnumEqualityCode
  | typeof enumOrderingCode
  | typeof incompleteEnumMatchCode
  | typeof duplicateEnumMatchArmCode
  | typeof enumMatchArmAfterWildcardCode
  | typeof foreignEnumPatternCode
  | typeof integerPatternAgainstEnumCode
  | typeof missingUnsafeBoundaryCode
  | typeof invalidConformanceCode
  | typeof invalidDropHookCode
  | typeof invalidStaticLiteralCode
  | typeof invalidConstantCode
  | typeof invalidConfigurationCode
  | typeof invalidPointerQualifierCode
  | typeof expressionStatementResultCode
  | typeof genericParameterKindMismatchCode
  | typeof contractRowInferenceCode
  | typeof invalidServiceDeclarationCode
  | typeof intrinsicTargetUnavailableCode
  | typeof invalidFloatLiteralCode
  | typeof ambiguousBoundOperationCode
  | typeof uninferredTypeParameterCode
  | typeof typeArgumentConflictCode
  | typeof unlowerableBoundWitnessCode
  | typeof storedCallableConstructionCode
  | typeof conflictingInitializerRepresentationCode
  | typeof divergentRepresentationJoinCode
  | typeof incompatibleRepresentationBoundCode
  | typeof storedRepresentedEffectConstructionCode
  | typeof overlappingConformanceCode
  | typeof nonTerminatingConformanceCode
  | typeof unprovenConformanceCode
  | typeof nonConcreteSpecializationCode
  | typeof providerNoMatchCode
  | typeof jointProviderSelectionConflictCode
  | typeof providerAmbiguityCode
  | typeof selectedRowCardinalityCode
  | typeof providerConformanceAmbiguityCode
  | typeof invalidProviderConformanceCode
  | typeof returnTypeMismatchCode
  | typeof missingReturnCode
  | typeof providerAccessMismatchCode
  | typeof unresolvedExactRepresentationItemCode
  | typeof ambiguousExactRepresentationItemCode
  | typeof uncallableExactRepresentationItemCode
  | typeof openExactRepresentationItemCode
  | typeof privateExactRepresentationLeakCode
  | typeof divergentOpaqueRealizationCode
  | typeof opaqueRealizationCycleCode
  | typeof inlineOpaqueLayoutCycleCode
  | typeof invalidOpaqueResultBinderCode
  | typeof missingOpaqueRealizationCode
  | typeof bodylessOpaqueResultCode
  | typeof effectBlockReturnMismatchCode
  | typeof emptyNominalUnionCode
  | typeof duplicateUnionVariantCode
  | typeof emptyUnionVariantCode
  | typeof unknownUnionVariantCode
  | typeof expectedNominalUnionCode
  | typeof invalidNominalUnionConstructionCode
  | typeof durationOutOfRangeCode
  | typeof invalidReferentProjectionCode
  | typeof tupleArityMismatchCode
  | typeof contextualAggregateKindMismatchCode
  | typeof anonymousAggregateJoinMismatchCode
  | typeof positionalFieldConstructionCode
  | typeof staticPhaseViolationCode
  | typeof selectedCompileErrorCode
  | typeof staticEvaluationCycleCode
  | typeof staticStepLimitCode
  | typeof staticCallDepthLimitCode
  | typeof staticRetainedValueLimitCode
  | typeof staticResidualGrowthLimitCode
  | typeof cyclicTypeAliasCode
  | typeof typeAliasParametersCode
  | typeof unsupportedForeignAbiCode
  | typeof foreignFunctionRequiresUnsafeCode
  | typeof foreignTypeNotAdmittedCode
  | typeof foreignDeclarationRestrictionCode
  | typeof foreignFunctionNotFirstClassCode
  | typeof invalidForeignSymbolCode
  | typeof reservedForeignSymbolCode
  | typeof conflictingForeignSignatureCode
  | typeof foreignFunctionTargetUnavailableCode
  | typeof invalidInherentHeadCode
  | typeof invalidInherentMemberCode
  | typeof duplicateInherentMemberCode
  | typeof importedInherentMemberCode
  | typeof associatedFunctionOnValueCode
  | typeof nestedAnonymousCallableCode
  | typeof ambiguousReceiverOperationCode
  | typeof exportSuspendsCode
  | typeof ambiguousSuppliedOperationCode
  | typeof suppliedOperationValueCode
  | typeof genericCLayoutRecordCode
  | typeof unsupportedCLayoutFieldCode
  | typeof invalidForeignCallbackCode
  | typeof missingDiagnosticContextCode
  | typeof invalidDiagnosticObserverCode
  | typeof foreignStaticTargetUnavailableCode
  | typeof useAfterMoveCode
  | typeof partialMoveCode
  | typeof explicitMoveRequiredCode
  | typeof overlappingAssignmentCode
  | typeof incompatibleLoopHeaderCode
  | typeof matchBorrowEscapeCode
  | typeof exclusiveMatchRequiresMutableCode
  | typeof guardConsumesPatternCode
  | typeof invalidMatchScrutineePlaceCode
  | typeof conflictingViewLoanCode
  | typeof ownerAccessDuringLoanCode
  | typeof borrowedMoveCode
  | typeof storedCallableInvocationAccessCode
  | typeof storedEffectRunAccessCode
  | typeof localSharedAccessEscapeCode
  | typeof incompatibleArmMergeCode
  | typeof executableBorrowEscapeCode
  | typeof wordLiteralOutOfRangeCode

/** A semantic declaration identity carried structurally to avoid a module cycle. */
export interface DeclarationEntity {
  readonly _tag: 'DeclarationId'
  readonly sourceId: string
  readonly ordinal: number
}

/** A compiler-known built-in actor operation named as a diagnostic target. */
export interface BuiltinEntity {
  readonly _tag: 'BuiltinTarget'
  readonly actor: string
  readonly operation: string
}

/** One deterministic source-level frame retained by a static diagnostic. */
export interface StaticTraceFrame<L = SourceSpan.SourceSpan> {
  readonly kind: 'Call' | 'SelectedArm' | 'StaticText'
  readonly label: string
  readonly arguments: ReadonlyArray<string>
  readonly span: L
}

export type ParserContext = 'syntax' | 'statement' | 'expression' | 'parameter' | 'delimiter'

/** Structured per-code data explaining why the originating phase diagnosed. */
export type Reason<L = SourceSpan.SourceSpan> =
  | {
      readonly _tag: 'InvalidPointerQualifier'
      readonly qualifier: string
      readonly detail: string
    }
  | { readonly _tag: 'ExpiredLifetime'; readonly lifetime: string }
  | { readonly _tag: 'InvalidSuspensionOwnership'; readonly detail: string }
  | { readonly _tag: 'UnsupportedBytes' }
  | { readonly _tag: 'UnknownLiteralModifier'; readonly modifier: string }
  | {
      readonly _tag: 'UnterminatedStaticLiteral'
      readonly modifier: string
      readonly delimiter: '"' | "'"
      readonly delimiterWidth: 1 | 3
    }
  | { readonly _tag: 'MissingBaseDigits'; readonly radix: 2 | 8 | 16 }
  | { readonly _tag: 'InvalidDigitSeparator' }
  | { readonly _tag: 'MissingExponentDigits' }
  | { readonly _tag: 'CharacterLiteralScalarCount'; readonly scalars: number }
  | { readonly _tag: 'InvalidDurationAmount' }
  | { readonly _tag: 'UnknownDurationUnit'; readonly spelling: string }
  | { readonly _tag: 'RepeatedDurationUnit'; readonly unit: string }
  | {
      readonly _tag: 'OutOfOrderDurationUnit'
      readonly unit: string
      readonly previous: string
    }
  | {
      readonly _tag: 'SubordinateDurationOutOfRange'
      readonly unit: string
      readonly amount: string
      readonly maximum: string
    }
  | { readonly _tag: 'MissingToken'; readonly expected: Token.TokenKind }
  | {
      readonly _tag: 'UnexpectedTokens'
      readonly unexpected: ReadonlyArray<Token.TokenKind>
      readonly context: ParserContext
      readonly expected: ReadonlyArray<string>
    }
  | { readonly _tag: 'ReservedTemplateSyntax' }
  | { readonly _tag: 'ReservedImportBinding'; readonly spelling: string }
  | {
      readonly _tag: 'ExpressionNestingLimitExceeded'
      readonly limit: number
      readonly attemptedDepth: number
    }
  | { readonly _tag: 'EmptyNominalUnion'; readonly union: string }
  | {
      readonly _tag: 'DuplicateUnionVariant'
      readonly spelling: string
      readonly originalSpan: L
    }
  | { readonly _tag: 'EmptyUnionVariant'; readonly variant: string }
  | { readonly _tag: 'UnknownUnionVariant'; readonly union: string; readonly variant: string }
  | { readonly _tag: 'ExpectedNominalUnion'; readonly actual: string }
  | { readonly _tag: 'InvalidNominalUnionConstruction'; readonly union: string }
  | {
      readonly _tag: 'DurationOutOfRange'
      readonly spelling: string
      readonly maximum: '18446744073709551615'
    }
  | {
      readonly _tag: 'TupleArityMismatch'
      readonly type: string
      readonly expected: number
      readonly actual: number
    }
  | {
      readonly _tag: 'ContextualAggregateKindMismatch'
      readonly expected: 'record' | 'tuple'
      readonly actual: string
    }
  | {
      readonly _tag: 'AnonymousAggregateJoinMismatch'
      readonly types: ReadonlyArray<string>
    }
  | { readonly _tag: 'PositionalFieldConstruction'; readonly type: string }
  | {
      readonly _tag: 'StaticPhaseViolation'
      readonly operation: string
      readonly target: string
      readonly trace: ReadonlyArray<StaticTraceFrame<L>>
    }
  | {
      readonly _tag: 'SelectedCompileError'
      readonly detail: string
      readonly target: string
      readonly trace: ReadonlyArray<StaticTraceFrame<L>>
    }
  | {
      readonly _tag: 'StaticEvaluationCycle'
      readonly application: string
      readonly target: string
      readonly trace: ReadonlyArray<StaticTraceFrame<L>>
    }
  | {
      readonly _tag: 'StaticEvaluationLimit'
      readonly resource: 'Steps' | 'CallDepth' | 'RetainedValueBytes' | 'ResidualNodes'
      readonly limit: number
      readonly target: string
      readonly trace: ReadonlyArray<StaticTraceFrame<L>>
    }
  | { readonly _tag: 'UnknownModule'; readonly module: string }
  | { readonly _tag: 'SelfImport'; readonly module: string }
  | { readonly _tag: 'UnknownType'; readonly spelling: string }
  | { readonly _tag: 'UnknownLifetime'; readonly spelling: string }
  | { readonly _tag: 'AmbiguousLifetimeElision' }
  | { readonly _tag: 'InvalidLifetimeBinder'; readonly detail: string }
  | { readonly _tag: 'UnsatisfiedLifetimeBound'; readonly longer: string; readonly shorter: string }
  | { readonly _tag: 'UnsatisfiedTypeOutlives'; readonly type: string; readonly lifetime: string }
  | {
      readonly _tag: 'IntegerOutOfRange'
      readonly spelling: string
      readonly type: string
      readonly maximum: string
      readonly minimum: string
    }
  | { readonly _tag: 'UsizeNegative'; readonly spelling: string }
  | { readonly _tag: 'InvalidFailureType'; readonly type: string }
  | { readonly _tag: 'FailureChannelOnOrdinary' }
  | { readonly _tag: 'FailOutsideEffect' }
  | { readonly _tag: 'UndeclaredFailure'; readonly type: string }
  | { readonly _tag: 'RunNonEffect'; readonly type: string }
  | { readonly _tag: 'UnhandledEffectFailures'; readonly failures: ReadonlyArray<string> }
  | { readonly _tag: 'InvalidEffectHandler'; readonly detail: string }
  | { readonly _tag: 'MutableEffectRecipe' }
  | { readonly _tag: 'NonFiniteEffectJoin'; readonly detail: string }
  | { readonly _tag: 'CallableIdentityErasure' }
  | { readonly _tag: 'UnknownOwnedCallableReturn' }
  | { readonly _tag: 'MissingUnsafeBoundary'; readonly operation: string }
  | { readonly _tag: 'MisplacedUnsafeAcknowledgement' }
  | { readonly _tag: 'NestedAnonymousCallable' }
  | {
      readonly _tag: 'LocalSharedLayoutMismatch'
      readonly expected: string
      readonly actual: string
    }
  | {
      readonly _tag: 'ExecutionLayoutMismatch'
      readonly expected: string
      readonly actual: string
    }
  | {
      readonly _tag: 'UnsatisfiedExecutableProperty'
      readonly property: 'Intrinsic.Detached' | 'Intrinsic.NonParking'
      readonly causes: ReadonlyArray<string>
    }
  | { readonly _tag: 'InvalidExecutablePropertyConjunct'; readonly conjunct: string }
  | { readonly _tag: 'InvalidConformance'; readonly detail: string }
  | { readonly _tag: 'InvalidOperatorContract'; readonly detail: string }
  | {
      readonly _tag: 'OperatorNotApplicable'
      readonly operator: string
      readonly operands: ReadonlyArray<string>
    }
  | {
      readonly _tag: 'AmbiguousOperator'
      readonly operator: string
      readonly candidates: ReadonlyArray<string>
    }
  | {
      readonly _tag: 'AmbiguousBoundOperation'
      readonly spelling: string
      readonly parameters: ReadonlyArray<string>
    }
  | {
      readonly _tag: 'UnlowerableBoundWitness'
      readonly spelling: string
      readonly provider: string
    }
  | { readonly _tag: 'InvalidServiceDeclaration'; readonly detail: string }
  | { readonly _tag: 'InvalidTestDeclaration'; readonly detail: string }
  | { readonly _tag: 'UnsupportedLowering' }
  | {
      readonly _tag: 'InvalidMutableParameter'
      readonly context: 'BorrowedView' | 'Contract'
    }
  | { readonly _tag: 'DeferredCallableMutation'; readonly spelling: string }
  | {
      readonly _tag: 'IntrinsicTargetUnavailable'
      readonly operation: string
      readonly target: Target.Id
    }
  | { readonly _tag: 'InvalidDropHook'; readonly detail: string }
  | { readonly _tag: 'InvalidStaticLiteral'; readonly detail: string }
  | { readonly _tag: 'InvalidFloatLiteral'; readonly spelling: string }
  | {
      readonly _tag: 'StoredCallableConstruction'
      readonly aggregate: string
      readonly field?: string
      readonly callable: string
    }
  | {
      readonly _tag: 'ConflictingInitializerRepresentation'
      readonly parameter: string
      readonly expected: string
      readonly actual: string
      readonly originalSpan: L
    }
  | {
      readonly _tag: 'DivergentRepresentationJoin'
      readonly expected: string
      readonly actual: string
      readonly originSpans: readonly [L, L]
    }
  | {
      readonly _tag: 'IncompatibleRepresentationBound'
      readonly parameter: string
      readonly required: string
      readonly actual: string
      readonly requiredDeclarationSpan?: L
      readonly actualDeclarationSpan?: L
    }
  | {
      readonly _tag: 'StoredRepresentedEffectConstruction'
      readonly aggregate: string
      readonly field?: string
      readonly effect: string
    }
  | {
      readonly _tag: 'OverlappingConformance'
      readonly head: string
      readonly other: string
    }
  | {
      readonly _tag: 'NonTerminatingConformance'
      readonly head: string
      readonly failures: ReadonlyArray<string>
    }
  | {
      readonly _tag: 'UnprovenConformance'
      readonly goal: string
      readonly detail: string
      readonly trace: ReadonlyArray<string>
    }
  | { readonly _tag: 'NonConcreteSpecialization'; readonly declaration: string }
  | {
      readonly _tag: 'ProviderSelection'
      readonly problem: ProviderSelection.SelectionProblem
    }
  | { readonly _tag: 'UnresolvedExactRepresentationItem'; readonly item: string }
  | {
      readonly _tag: 'AmbiguousExactRepresentationItem'
      readonly item: string
      readonly count: number
    }
  | {
      readonly _tag: 'UncallableExactRepresentationItem'
      readonly item: string
      readonly subject: UncallableExactRepresentationSubject
    }
  | {
      readonly _tag: 'OpenExactRepresentationItem'
      readonly item: string
      readonly expected: number
      readonly actual: number
    }
  | { readonly _tag: 'PrivateExactRepresentationLeak'; readonly item: string }
  | {
      readonly _tag: 'DivergentOpaqueRealization'
      readonly family: string
      readonly realizations: ReadonlyArray<string>
    }
  | { readonly _tag: 'OpaqueRealizationCycle'; readonly families: ReadonlyArray<string> }
  | { readonly _tag: 'InlineOpaqueLayoutCycle'; readonly families: ReadonlyArray<string> }
  | {
      readonly _tag: 'InvalidOpaqueResultBinder'
      readonly binder: string
      readonly actual: 'Lifetime' | 'Value' | 'RequirementRow'
    }
  | { readonly _tag: 'MissingOpaqueRealization'; readonly family: string }
  | {
      readonly _tag: 'BodylessOpaqueResult'
      readonly declaration: string
      readonly context: 'ServiceOperation' | 'InterfaceOperation'
    }
  | { readonly _tag: 'InvalidConstant'; readonly detail: string }
  | { readonly _tag: 'InvalidConfiguration'; readonly error: ConfigurationError.ConfigurationError }
  | { readonly _tag: 'ExpressionStatementResult'; readonly actual: string }
  | { readonly _tag: 'InvalidRequirementType'; readonly type: string }
  | { readonly _tag: 'UnhandledEffectRequirements'; readonly requirements: ReadonlyArray<string> }
  | { readonly _tag: 'InvalidEffectProvision'; readonly detail: string }
  | {
      readonly _tag: 'WordLiteralOutOfRange'
      readonly type: 'usize' | 'isize'
      readonly spelling: string
      readonly target: string
      readonly bits: 32 | 64
      readonly minimum: string
      readonly maximum: string
    }
  | {
      readonly _tag: 'DuplicateDeclarationName'
      readonly spelling: string
      readonly originalSpan: L
    }
  | { readonly _tag: 'UnknownFunction'; readonly spelling: string }
  | {
      readonly _tag: 'DuplicateParameterName'
      readonly spelling: string
      readonly originalSpan: L
    }
  | { readonly _tag: 'UnknownValueReference'; readonly spelling: string }
  | {
      readonly _tag: 'WrongCallArity'
      readonly target: DeclarationEntity | BuiltinEntity
      readonly expectedCount: number
      readonly actualCount: number
    }
  | {
      readonly _tag: 'RebindingName'
      readonly spelling: string
      readonly originalSpan: L
    }
  | { readonly _tag: 'UnknownActor'; readonly spelling: string }
  | {
      readonly _tag: 'UnknownActorOperation'
      readonly actor: string
      readonly spelling: string
    }
  | { readonly _tag: 'ConditionNotBool'; readonly actual: string }
  | {
      readonly _tag: 'ArgumentTypeMismatch'
      readonly expected: string
      readonly actual: string
    }
  | {
      readonly _tag: 'ReturnTypeMismatch'
      readonly expected: string
      readonly actual: string
    }
  | { readonly _tag: 'MissingReturn'; readonly expected: string }
  | { readonly _tag: 'NonCallableApplication'; readonly actual: string }
  | {
      readonly _tag: 'IncompatibleCallableSignature'
      readonly expected: string
      readonly actual: string
    }
  | {
      readonly _tag: 'InvalidCallableInvocationAccess'
      readonly required: 'Shared' | 'Exclusive' | 'Take'
    }
  | { readonly _tag: 'RedundantUnaryEmptyCall'; readonly target: string }
  | { readonly _tag: 'UnknownImportedMember'; readonly module: string; readonly spelling: string }
  | {
      readonly _tag: 'InaccessibleImportedMember'
      readonly module: string
      readonly spelling: string
    }
  | { readonly _tag: 'BindingConflict'; readonly spelling: string }
  | {
      readonly _tag: 'DuplicateFieldName'
      readonly spelling: string
      readonly originalSpan: L
    }
  | { readonly _tag: 'EmptyEnum'; readonly enum: string }
  | {
      readonly _tag: 'UnsupportedEnumRepresentation'
      readonly spelling: string
      readonly allowed: ReadonlyArray<string>
    }
  | {
      readonly _tag: 'DuplicateEnumMemberName'
      readonly spelling: string
      readonly originalSpan: L
    }
  | {
      readonly _tag: 'DuplicateEnumDiscriminant'
      readonly value: string
      readonly originalSpan: L
    }
  | {
      readonly _tag: 'EnumDiscriminantOutOfRange'
      readonly representation: string
      readonly value: string
      readonly minimum: string
      readonly maximum: string
    }
  | {
      readonly _tag: 'EnumImplicitDiscriminantOverflow'
      readonly representation: string
      readonly predecessor: string
      readonly maximum: string
    }
  | {
      readonly _tag: 'UnsignedEnumNegativeDiscriminant'
      readonly representation: string
      readonly value: string
    }
  | { readonly _tag: 'UnknownEnumMember'; readonly enum: string; readonly member: string }
  | { readonly _tag: 'WrongEnumMember'; readonly expected: string; readonly actual: string }
  | {
      readonly _tag: 'EnumIntegerMismatch'
      readonly enum: string
      readonly integer: string
      readonly direction: 'IntegerToEnum' | 'EnumToInteger'
    }
  | { readonly _tag: 'CrossEnumEquality'; readonly left: string; readonly right: string }
  | { readonly _tag: 'EnumOrdering'; readonly enum: string; readonly operator: string }
  | {
      readonly _tag: 'IncompleteEnumMatch'
      readonly enum: string
      readonly missing: ReadonlyArray<string>
    }
  | {
      readonly _tag: 'DuplicateEnumMatchArm'
      readonly member: string
      readonly originalSpan: L
    }
  | {
      readonly _tag: 'EnumMatchArmAfterWildcard'
      readonly wildcardSpan: L
    }
  | { readonly _tag: 'ForeignEnumPattern'; readonly expected: string; readonly actual: string }
  | { readonly _tag: 'IntegerPatternAgainstEnum'; readonly enum: string; readonly value: string }
  | { readonly _tag: 'ExpectedType'; readonly spelling: string }
  | { readonly _tag: 'PrivateTypeExposure'; readonly type: string }
  | { readonly _tag: 'InlineRecursiveAggregate'; readonly members: ReadonlyArray<string> }
  | { readonly _tag: 'CyclicTypeAlias'; readonly aliases: ReadonlyArray<string> }
  | { readonly _tag: 'TypeAliasParameters'; readonly alias: string }
  | { readonly _tag: 'UnsupportedForeignAbi'; readonly abi: string }
  | { readonly _tag: 'GenericCLayoutRecord'; readonly record: string }
  | {
      readonly _tag: 'UnsupportedCLayoutField'
      readonly record: string
      readonly field: string
      readonly type: string
    }
  | { readonly _tag: 'ForeignFunctionRequiresUnsafe'; readonly name: string }
  | { readonly _tag: 'ForeignTypeNotAdmitted'; readonly type: string; readonly abi: string }
  | { readonly _tag: 'ForeignDeclarationRestriction'; readonly restriction: string }
  | { readonly _tag: 'ForeignFunctionNotFirstClass'; readonly name: string }
  | { readonly _tag: 'InvalidForeignCallback'; readonly name: string; readonly detail: string }
  | { readonly _tag: 'MissingDiagnosticContext' }
  | { readonly _tag: 'InvalidDiagnosticObserver'; readonly detail: string }
  | {
      readonly _tag: 'ForeignStaticTargetUnavailable'
      readonly symbol: string
      readonly surface: string
    }
  | { readonly _tag: 'InvalidForeignSymbol'; readonly symbol: string }
  | { readonly _tag: 'ReservedForeignSymbol'; readonly symbol: string }
  | {
      readonly _tag: 'ConflictingForeignSignature'
      readonly symbol: string
      readonly otherSpan: L
    }
  | {
      readonly _tag: 'ForeignFunctionTargetUnavailable'
      readonly symbol: string
      readonly surface: string
    }
  | { readonly _tag: 'InaccessibleStructConstruction'; readonly type: string }
  | { readonly _tag: 'UnknownStructField'; readonly type: string; readonly field: string }
  | {
      readonly _tag: 'DuplicateStructInitializer'
      readonly field: string
      readonly originalSpan: L
    }
  | { readonly _tag: 'MissingStructInitializer'; readonly type: string; readonly field: string }
  | {
      readonly _tag: 'StructFieldTypeMismatch'
      readonly field: string
      readonly expected: string
      readonly actual: string
    }
  | { readonly _tag: 'ProjectionOnNonStruct'; readonly actual: string }
  | { readonly _tag: 'InvalidReferentProjection'; readonly actual: string }
  | { readonly _tag: 'UnknownProjectedField'; readonly type: string; readonly field: string }
  | { readonly _tag: 'InaccessibleProjectedField'; readonly type: string; readonly field: string }
  | { readonly _tag: 'EmptyArrayNeedsContext' }
  | {
      readonly _tag: 'ArrayElementTypeMismatch'
      readonly expected: string
      readonly actual: string
      readonly index: number
    }
  | {
      readonly _tag: 'ArrayLengthMismatch'
      readonly expected: number
      readonly actual: number
    }
  | { readonly _tag: 'IndexOnNonArray'; readonly actual: string }
  | { readonly _tag: 'IndexNotUsize'; readonly actual: string }
  | { readonly _tag: 'IndexOutOfBounds'; readonly index: number; readonly length: number }
  | { readonly _tag: 'ImmutableAssignment'; readonly spelling: string }
  | { readonly _tag: 'InvalidAssignmentPlace' }
  | {
      readonly _tag: 'AssignmentTypeMismatch'
      readonly expected: string
      readonly actual: string
    }
  | { readonly _tag: 'TransferOutsideLoop'; readonly transfer: 'break' | 'continue' }
  | { readonly _tag: 'InvalidUnionMember'; readonly type: string }
  | {
      readonly _tag: 'IncompatibleUnionConversion'
      readonly source: string
      readonly target: string
      readonly missing: ReadonlyArray<string>
    }
  | { readonly _tag: 'MatchScrutineeNotNominal'; readonly actual: string }
  | {
      readonly _tag: 'MatchMemberNotInScrutinee'
      readonly member: string
      readonly scrutinee: string
    }
  | { readonly _tag: 'UnreachableMatchArm'; readonly member: string }
  | { readonly _tag: 'IncompleteMatch'; readonly missing: ReadonlyArray<string> }
  | {
      readonly _tag: 'RefutableLetPattern'
      readonly actual: string
      readonly missing: ReadonlyArray<string>
    }
  | { readonly _tag: 'MatchGuardNotBool'; readonly actual: string }
  | { readonly _tag: 'MissingPatternField'; readonly type: string; readonly field: string }
  | {
      readonly _tag: 'DuplicatePatternField'
      readonly field: string
      readonly originalSpan: L
    }
  | {
      readonly _tag: 'PatternBindingConflict'
      readonly spelling: string
      readonly originalSpan: L
    }
  | { readonly _tag: 'IncompatibleMatchResults'; readonly types: ReadonlyArray<string> }
  | { readonly _tag: 'EffectBlockReturnMismatch'; readonly types: ReadonlyArray<string> }
  | {
      readonly _tag: 'DuplicateTypeParameter'
      readonly spelling: string
      readonly originalSpan: L
    }
  | {
      readonly _tag: 'TypeArgumentArity'
      readonly target: string
      readonly expected: number
      readonly actual: number
    }
  | { readonly _tag: 'TypeArgumentInference'; readonly target: string }
  | {
      readonly _tag: 'UninferredTypeParameter'
      readonly target: string
      readonly parameter: string
    }
  | {
      readonly _tag: 'TypeArgumentConflict'
      readonly target: string
      readonly parameter: string
      readonly written: string
      readonly implied: string
    }
  | {
      readonly _tag: 'PolymorphicRecursion'
      readonly caller: string
      readonly target: string
    }
  | {
      readonly _tag: 'GenericParameterKindMismatch'
      readonly spelling: string
      readonly expected:
        | 'Lifetime'
        | 'Value'
        | 'RequirementRow'
        | 'CallableRepresentation'
        | 'EffectRepresentation'
      readonly actual:
        | 'Lifetime'
        | 'Value'
        | 'RequirementRow'
        | 'CallableRepresentation'
        | 'EffectRepresentation'
    }
  | {
      readonly _tag: 'ContractRowInference'
      readonly problem:
        | { readonly _tag: 'AbsentFailureMember'; readonly member: string }
        | {
            readonly _tag: 'AbsentRequirementMember'
            readonly capability: string
            readonly role: string
            readonly access: 'Shared' | 'Exclusive'
          }
        | {
            readonly _tag: 'IncompatibleRequirementRole'
            readonly capability: string
            readonly expected: string
            readonly actual: ReadonlyArray<string>
          }
        | {
            readonly _tag: 'IncompatibleRequirementAccess'
            readonly capability: string
            readonly role: string
            readonly expected: 'Shared' | 'Exclusive'
            readonly actual: ReadonlyArray<'Shared' | 'Exclusive'>
          }
        | {
            readonly _tag: 'AmbiguousRequirementRemainder'
            readonly parameters: ReadonlyArray<string>
          }
        | { readonly _tag: 'NonFiniteRequirementRow' }
    }
  | { readonly _tag: 'InvalidBorrowOperand' }
  | { readonly _tag: 'ExclusiveBorrowRequiresMutable'; readonly spelling: string }
  | {
      readonly _tag: 'InvalidSliceReborrow'
      readonly parent: 'Shared' | 'Exclusive'
      readonly requested: 'Shared' | 'Exclusive'
    }
  | { readonly _tag: 'ImplicitSliceDecay'; readonly expected: string }
  | {
      readonly _tag: 'UseAfterMove'
      readonly spelling: string
      readonly moveSpan: L
    }
  | { readonly _tag: 'PartialMove' }
  | {
      readonly _tag: 'StoredCallableInvocationAccess'
      readonly aggregate: string
      readonly field: string
      readonly contract: string
      readonly receiver: 'Shared' | 'Exclusive' | 'Take'
      readonly required: 'Shared' | 'Exclusive' | 'Take'
    }
  | {
      readonly _tag: 'StoredEffectRunAccess'
      readonly aggregate: string
      readonly field: string
      readonly contract: string
      readonly receiver: 'Shared' | 'Exclusive' | 'Take'
      readonly required: 'Shared' | 'Exclusive' | 'Take'
    }
  | { readonly _tag: 'ExplicitMoveRequired'; readonly spelling: string }
  | { readonly _tag: 'OverlappingAssignment'; readonly spelling: string }
  | { readonly _tag: 'IncompatibleLoopHeader'; readonly loop: number }
  | { readonly _tag: 'IncompatibleArmMerge'; readonly spelling: string }
  | { readonly _tag: 'MatchBorrowEscape'; readonly spelling: string }
  | {
      readonly _tag: 'ExecutableBorrowEscape'
      readonly executable: 'Callable' | 'Effect'
      readonly spelling: string
      readonly access: 'Shared' | 'Exclusive'
    }
  | { readonly _tag: 'ExclusiveMatchRequiresMutable'; readonly spelling: string }
  | { readonly _tag: 'GuardConsumesPattern'; readonly spelling: string }
  | { readonly _tag: 'InvalidMatchScrutineePlace'; readonly access: 'Move' | 'Exclusive' | 'Place' }
  | {
      readonly _tag: 'ConflictingViewLoan'
      readonly existing: 'Shared' | 'Exclusive'
      readonly requested: 'Shared' | 'Exclusive'
      readonly loanSpan: L
    }
  | {
      readonly _tag: 'OwnerAccessDuringLoan'
      readonly spelling: string
      readonly access: 'Read' | 'Write' | 'Move'
      readonly loanSpan: L
    }
  | { readonly _tag: 'BorrowedMove' }
  | {
      readonly _tag: 'LocalSharedAccessEscape'
      readonly kind: 'Callback' | 'Result' | 'Suspension'
    }
  | {
      readonly _tag: 'InvalidInherentHead'
      readonly owner: string
      readonly problem: 'Specialized' | 'Bounded' | 'ForeignOwner' | 'AliasOwner' | 'NotNominal'
    }
  | {
      readonly _tag: 'InvalidInherentMember'
      readonly owner: string
      readonly member: string
      readonly problem: 'MappedOperation' | 'DropHook' | 'Collision'
      readonly collidesWith?: string
    }
  | { readonly _tag: 'DuplicateInherentMember'; readonly owner: string; readonly member: string }
  | {
      readonly _tag: 'ImportedInherentMember'
      readonly module: string
      readonly member: string
      readonly owner: string
    }
  | {
      readonly _tag: 'AssociatedFunctionOnValue'
      readonly owner: string
      readonly member: string
    }
  | {
      readonly _tag: 'AmbiguousReceiverOperation'
      readonly parameter: string
      readonly member: string
      readonly interfaces: ReadonlyArray<string>
    }
  | {
      readonly _tag: 'SuppliedOperationValue'
      readonly receiver: string
      readonly member: string
    }
  | {
      readonly _tag: 'AmbiguousSuppliedOperation'
      readonly receiver: string
      readonly member: string
      readonly interfaces: ReadonlyArray<string>
    }
  | { readonly _tag: 'ExportSuspends'; readonly symbol: string }
/** One additional source span labeled with its relationship to the diagnostic. */
export interface RelatedSpan<L = SourceSpan.SourceSpan> {
  readonly label: string
  readonly span: L
}

/**
 * One unambiguous machine-applicable replacement: the corrected bytes for one source range.
 *
 * A phase emits an edit only where the correction needs no name choice and no type decision from
 * the author; every other diagnostic carries none. Applying every edit of one diagnostic to its
 * source removes that diagnostic. All edits of one diagnostic address the source that owns the
 * diagnostic's primary span, and no two of them overlap, so a consumer may apply them in any
 * order. Every edit is derived from byte offsets alone, so repeated compilations of the same
 * source produce byte-identical edits.
 */
export interface Edit {
  readonly span: SourceSpan.SourceSpan
  readonly replacement: string
}

/**
 * A deterministic diagnostic identity: derived from the phase, code, primary span, and the
 * ordinal among equal (phase, code, span) diagnostics within one phase result. Reproducible
 * across runs because every phase is deterministic.
 */
export interface Identity<L = SourceSpan.SourceSpan> {
  readonly _tag: 'DiagnosticIdentity'
  readonly phase: Phase
  readonly code: Code
  readonly span: L
  readonly ordinal: number
}

/**
 * A recoverable source mistake published by one compiler phase as ordinary data.
 *
 * `L` is where it points. A published diagnostic points at a source span. A diagnostic held by a
 * reusable semantic product points at a revision-free `Location` and gains its span when the
 * product is published for a revision.
 */
export interface Diagnostic<L = SourceSpan.SourceSpan> {
  readonly _tag: 'Diagnostic'
  readonly phase: Phase
  readonly code: Code
  readonly severity: 'error'
  readonly message: string
  readonly reason: Reason<L>
  readonly span: L
  readonly relatedSpans?: ReadonlyArray<RelatedSpan<L>>
  readonly notes?: ReadonlyArray<string>
  readonly edits?: ReadonlyArray<Edit>
  readonly entity?: DeclarationEntity
  readonly cause?: Identity<L>
}

/** A diagnostic held by a reusable semantic product. */
export type Located = Diagnostic<Location.Location>

/** Tests whether a diagnostic collection contains an emission-blocking error. */
export const hasErrors = (diagnostics: ReadonlyArray<Diagnostic>): boolean =>
  diagnostics.some((diagnostic) => diagnostic.severity === 'error')

/** Tests whether target-dependent specialization must stop for a generic source error. */
export const hasGenericSpecializationErrors = (diagnostics: ReadonlyArray<Diagnostic>): boolean =>
  diagnostics.some(
    (diagnostic) =>
      diagnostic.code === duplicateTypeParameterCode ||
      diagnostic.code === typeArgumentArityCode ||
      diagnostic.code === typeArgumentInferenceCode ||
      diagnostic.code === uninferredTypeParameterCode ||
      diagnostic.code === typeArgumentConflictCode ||
      diagnostic.code === genericParameterKindMismatchCode ||
      diagnostic.code === incompatibleRepresentationBoundCode ||
      diagnostic.code === contractRowInferenceCode ||
      diagnostic.code === invalidEffectProvisionCode ||
      diagnostic.code === providerNoMatchCode ||
      diagnostic.code === jointProviderSelectionConflictCode ||
      diagnostic.code === providerAmbiguityCode ||
      diagnostic.code === selectedRowCardinalityCode ||
      diagnostic.code === providerConformanceAmbiguityCode ||
      diagnostic.code === invalidProviderConformanceCode ||
      diagnostic.code === nonConcreteSpecializationCode ||
      diagnostic.code === polymorphicRecursionCode,
  )

/**
 * Tests whether a reachable-instance fence diagnostic denies target realization.
 *
 * A stored-callable construction (#184) is exactly a program the layout planner cannot serve: the
 * violating aggregates would receive unavailable layout entries and MIR validation would fail with
 * `MissingTypeLayout`/`InvalidAggregateOperation`. Realization stops here so the source diagnostic
 * is the only reported failure, instead of being followed by an `InvalidMir` echo of itself.
 */
export const hasInstanceFenceErrors = (diagnostics: ReadonlyArray<Diagnostic>): boolean =>
  diagnostics.some(
    (diagnostic) =>
      diagnostic.code === storedCallableConstructionCode ||
      diagnostic.code === storedRepresentedEffectConstructionCode,
  )

/** Tests whether source return-contract errors must stop every target-dependent phase. */
export const hasReturnContractErrors = (diagnostics: ReadonlyArray<Diagnostic>): boolean =>
  diagnostics.some(
    (diagnostic) =>
      diagnostic.code === returnTypeMismatchCode || diagnostic.code === missingReturnCode,
  )

/** Derives the identity of one diagnostic given its ordinal among equals. */
export const identity = <L>(self: Diagnostic<L>, ordinal = 0): Identity<L> => ({
  _tag: 'DiagnosticIdentity',
  phase: self.phase,
  code: self.code,
  span: self.span,
  ordinal,
})

/** Derives every identity for one phase result, assigning ordinals among equals in order. */
export const identify = (diagnostics: ReadonlyArray<Diagnostic>): ReadonlyArray<Identity> => {
  const seen = new Map<string, number>()
  return diagnostics.map((diagnostic) => {
    const key = `${diagnostic.phase}\0${diagnostic.code}\0${diagnostic.span.sourceId}\0${diagnostic.span.start}\0${diagnostic.span.end}`
    const ordinal = seen.get(key) ?? 0
    seen.set(key, ordinal + 1)
    return identity(diagnostic, ordinal)
  })
}

/** Tests structural identity equality. */
export const identityEquals = (self: CauseIdentity, other: CauseIdentity): boolean =>
  self.phase === other.phase &&
  self.code === other.code &&
  causeLabel(self) === causeLabel(other) &&
  self.ordinal === other.ordinal

const compareStrings = (left: string, right: string): number => {
  if (left < right) {
    return -1
  }
  if (left > right) {
    return 1
  }
  return 0
}

/**
 * The single cross-phase ordering: module identity, primary span, code, then phase rank.
 *
 * ponytail: span.sourceId stands in for canonical module identity until load-module-closure.
 */
export const compare = (left: Diagnostic, right: Diagnostic): number =>
  compareStrings(left.span.sourceId, right.span.sourceId) ||
  left.span.start - right.span.start ||
  left.span.end - right.span.end ||
  compareStrings(left.code, right.code) ||
  phaseRank[left.phase] - phaseRank[right.phase]

/** Orders identities with the same keys as {@link compare}, then by ordinal. */
export const compareIdentity = (left: Identity, right: Identity): number =>
  compareStrings(left.span.sourceId, right.span.sourceId) ||
  left.span.start - right.span.start ||
  left.span.end - right.span.end ||
  compareStrings(left.code, right.code) ||
  phaseRank[left.phase] - phaseRank[right.phase] ||
  left.ordinal - right.ordinal

/**
 * Merges per-phase collections into the one deterministic driver-side sequence.
 *
 * The stable sort preserves each phase's within-result order as the final tie-breaker.
 */
export const merge = (
  ...collections: ReadonlyArray<ReadonlyArray<Diagnostic>>
): ReadonlyArray<Diagnostic> => collections.flat().sort(compare)

/**
 * Joins diagnostics that are not published yet, keeping their deterministic emission order.
 *
 * A located diagnostic has no offsets to sort by; `publish` orders them once their spans exist.
 */
export const collect = <L>(
  ...collections: ReadonlyArray<ReadonlyArray<Diagnostic<L>>>
): ReadonlyArray<Diagnostic<L>> => collections.flat()

/** The reason fields that hold a position, so publication can resolve them with the diagnostic. */
const positionFields = [
  'originalSpan',
  'loanSpan',
  'wildcardSpan',
  'requiredDeclarationSpan',
  'actualDeclarationSpan',
  'otherSpan',
  'moveSpan',
] as const

/**
 * A cause as a stage after TIR may hold it.
 *
 * ponytail: those stages still report in source coordinates, yet they also read header facts,
 * whose causes are revision-free. One type once those stages read TIR nodes (task 3.3.3).
 */
export type CauseIdentity = Identity | Identity<Location.Location>

/** A stable text for a cause, in whichever coordinates it holds. */
export const causeLabel = (self: CauseIdentity): string =>
  'sourceId' in self.span
    ? `${self.span.sourceId}:${self.span.start}-${self.span.end}`
    : Location.key(self.span)

/** Gives a located identity its span for one revision. */
export const publishIdentity = (
  self: Identity<Location.Location>,
  registry: SemanticContext.Registry,
): Identity => ({ ...self, span: Location.resolve(self.span, registry).span })

/**
 * Gives a located diagnostic its spans for one revision.
 *
 * A value range split across several written literals reports at the first and relates the rest.
 */
export const publish = (self: Located, registry: SemanticContext.Registry): Diagnostic => {
  const primary = Location.resolve(self.span, registry)
  const span = (location: Location.Location): SourceSpan.SourceSpan =>
    Location.resolve(location, registry).span
  const reason: Record<string, unknown> = { ...self.reason }
  for (const field of positionFields) {
    const value = reason[field]
    if (value !== undefined) reason[field] = span(value as Location.Location)
  }
  if (Array.isArray(reason['originSpans']))
    reason['originSpans'] = (reason['originSpans'] as ReadonlyArray<Location.Location>).map(span)
  if (Array.isArray(reason['trace']))
    reason['trace'] =
      // A conformance trace is lines of text; only static-evaluation frames hold a position.
      (reason['trace'] as ReadonlyArray<string | StaticTraceFrame<Location.Location>>).map(
        (frame) => (typeof frame === 'string' ? frame : { ...frame, span: span(frame.span) }),
      )
  const relatedSpans = [
    ...primary.related.map((related) => ({ label: 'continues here', span: related })),
    ...(self.relatedSpans ?? []).map((related) => ({
      label: related.label,
      span: span(related.span),
    })),
  ]
  return {
    ...self,
    // The reason vocabulary is identical on both sides; only its position fields changed type.
    reason: reason as unknown as Reason,
    span: primary.span,
    ...(relatedSpans.length === 0 ? {} : { relatedSpans: relatedSpans }),
    ...(self.cause === undefined ? {} : { cause: publishIdentity(self.cause, registry) }),
  } as Diagnostic
}

/** Publishes a collection in its emission order; `merge` gives the final order. */
export const publishAll = (
  diagnostics: ReadonlyArray<Located>,
  registry: SemanticContext.Registry,
): ReadonlyArray<Diagnostic> => diagnostics.map((diagnostic) => publish(diagnostic, registry))

/** Creates the diagnostic associated with one `Invalid` token. */
export const unsupportedBytes = <L>(span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'lexical',
  code: unsupportedBytesCode,
  severity: 'error',
  message: 'Unsupported byte sequence',
  reason: { _tag: 'UnsupportedBytes' as const },
  span,
})

/** Creates the lexical diagnostic for one reserved but unrecognized literal modifier. */
export const unknownLiteralModifier = <L>(modifier: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'lexical',
  code: unknownLiteralModifierCode,
  severity: 'error',
  message: `Unknown static-literal modifier: ${modifier}`,
  reason: { _tag: 'UnknownLiteralModifier' as const, modifier },
  span,
})

/** Creates the lexical diagnostic for one deterministic unterminated-literal recovery range. */
export const unterminatedStaticLiteral = <L>(
  modifier: string,
  delimiterWidth: 1 | 3,
  span: L,
  delimiter: '"' | "'" = '"',
): Diagnostic<L> => {
  let subject: string
  if (delimiter === "'") {
    subject = 'character'
  } else {
    subject = `${delimiterWidth === 3 ? 'multiline ' : ''}static`
  }
  return {
    _tag: 'Diagnostic',
    phase: 'lexical',
    code: unterminatedStaticLiteralCode,
    severity: 'error',
    message: `Unterminated ${subject} literal`,
    reason: {
      _tag: 'UnterminatedStaticLiteral' as const,
      modifier,
      delimiter,
      delimiterWidth,
    },
    span,
  }
}

/**
 * Creates the lexical diagnostic for one character literal that does not denote one scalar.
 *
 * The rule counts Unicode scalars rather than bytes, so a multi-byte scalar such as `'é'` is one
 * character and never a length error.
 */
export const characterLiteralScalarCount = <L>(scalars: number, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'lexical',
  code: characterLiteralScalarCountCode,
  severity: 'error',
  message: `Character literal must hold exactly one Unicode scalar, but holds ${scalars}`,
  reason: { _tag: 'CharacterLiteralScalarCount' as const, scalars },
  span,
})

/** Creates the lexical diagnostic for a duration amount that is not a whole decimal integer. */
export const invalidDurationAmount = <L>(span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'lexical',
  code: invalidDurationAmountCode,
  severity: 'error',
  message: 'Duration components require whole decimal amounts',
  reason: { _tag: 'InvalidDurationAmount' as const },
  span,
})

/** Creates the lexical diagnostic for one unknown duration unit suffix. */
export const unknownDurationUnit = <L>(spelling: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'lexical',
  code: unknownDurationUnitCode,
  severity: 'error',
  message: `Unknown duration unit ${spelling}`,
  reason: { _tag: 'UnknownDurationUnit' as const, spelling },
  span,
})

/** Creates the lexical diagnostic for one duration unit repeated in a compact literal. */
export const repeatedDurationUnit = <L>(unit: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'lexical',
  code: repeatedDurationUnitCode,
  severity: 'error',
  message: `Duration unit ${unit} may appear only once`,
  reason: { _tag: 'RepeatedDurationUnit' as const, unit },
  span,
})

/** Creates the lexical diagnostic for a duration unit written after a smaller unit. */
export const outOfOrderDurationUnit = <L>(
  unit: string,
  previous: string,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'lexical',
  code: outOfOrderDurationUnitCode,
  severity: 'error',
  message: `Duration unit ${unit} must not follow ${previous}`,
  reason: { _tag: 'OutOfOrderDurationUnit' as const, unit, previous },
  span,
})

/** Creates the lexical diagnostic for a non-leading duration component outside its field bound. */
export const subordinateDurationOutOfRange = <L>(
  unit: string,
  amount: bigint,
  maximum: bigint,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'lexical',
  code: subordinateDurationOutOfRangeCode,
  severity: 'error',
  message: `Subordinate ${unit} component ${amount} exceeds ${maximum}`,
  reason: {
    _tag: 'SubordinateDurationOutOfRange' as const,
    unit,
    amount: amount.toString(),
    maximum: maximum.toString(),
  },
  span,
})

/** Creates the lexical diagnostic for one base prefix that no digit of its base follows. */
export const missingBaseDigits = <L>(radix: 2 | 8 | 16, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'lexical',
  code: missingBaseDigitsCode,
  severity: 'error',
  message: `Base-${radix} integer literal without digits`,
  reason: { _tag: 'MissingBaseDigits' as const, radix },
  span,
})

/** Creates the lexical diagnostic for one number literal whose `_` is not between two digits. */
export const invalidDigitSeparator = <L>(span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'lexical',
  code: invalidDigitSeparatorCode,
  severity: 'error',
  message: 'Digit separator must sit between two digits',
  reason: { _tag: 'InvalidDigitSeparator' as const },
  span,
})

/** Creates the lexical diagnostic for one exponent marker that no exponent digit follows. */
export const missingExponentDigits = <L>(span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'lexical',
  code: missingExponentDigitsCode,
  severity: 'error',
  message: 'Float literal exponent must have at least one digit',
  reason: { _tag: 'MissingExponentDigits' as const },
  span,
})

/** Creates the semantic diagnostic for a static literal that cannot decode atomically. */
export const invalidStaticLiteral = <L>(detail: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: invalidStaticLiteralCode,
  severity: 'error',
  message: `Invalid static literal: ${detail}`,
  reason: { _tag: 'InvalidStaticLiteral' as const, detail },
  span,
})

/** Creates the semantic diagnostic for a float spelling no floating-point value can represent. */
export const invalidFloatLiteral = <L>(spelling: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: invalidFloatLiteralCode,
  severity: 'error',
  message: `Invalid float literal: ${spelling}`,
  reason: { _tag: 'InvalidFloatLiteral' as const, spelling },
  span,
})

/** Creates the semantic diagnostic for a constant outside the literal scalar contract. */
export const invalidConstant = <L>(detail: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: invalidConstantCode,
  severity: 'error',
  message: `Invalid constant: ${detail}`,
  reason: { _tag: 'InvalidConstant' as const, detail },
  span,
})

/** Creates the declaration diagnostic for an invalid interface operator marker. */
export const invalidOperatorContract = <L>(detail: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: invalidOperatorContractCode,
  severity: 'error',
  message: `Invalid operator contract: ${detail}`,
  reason: { _tag: 'InvalidOperatorContract' as const, detail },
  span,
})

/** Creates the operator-site diagnostic when no marked operation accepts the operands. */
export const operatorNotApplicable = <L>(
  operator: string,
  operands: ReadonlyArray<string>,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: operatorNotApplicableCode,
  severity: 'error',
  message: `Operator ${operator} does not accept (${operands.join(', ')})`,
  reason: { _tag: 'OperatorNotApplicable' as const, operator, operands },
  span,
})

/** Creates the operator-site diagnostic when static conformance leaves multiple candidates. */
export const ambiguousOperator = <L>(
  operator: string,
  candidates: ReadonlyArray<string>,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: ambiguousOperatorCode,
  severity: 'error',
  message: `Operator ${operator} is ambiguous between ${candidates.join(', ')}`,
  reason: { _tag: 'AmbiguousOperator' as const, operator, candidates },
  span,
})

/** Creates the semantic diagnostic for an unused non-unit expression-statement result. */
export const expressionStatementResult = <L>(actual: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: expressionStatementResultCode,
  severity: 'error',
  message: `Expression statement produces ${actual}, but only () or never may be ignored`,
  reason: { _tag: 'ExpressionStatementResult' as const, actual },
  span,
  notes: ['Bind the value with `let`, return it, or consume it explicitly with `drop`.'],
})

/** Creates the diagnostic associated with one missing token leaf. */
export const missingToken = <L>(expected: Token.TokenKind, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'parser',
  code: missingTokenCode,
  severity: 'error',
  message: `Expected ${Token.describe(expected)}`,
  reason: { _tag: 'MissingToken' as const, expected },
  span,
})

const unexpectedTokensMessage = (
  encountered: string,
  context: ParserContext,
  expectation: string | undefined,
): string => {
  if (context === 'syntax') {
    if (expectation === undefined) return `Unexpected ${encountered}; expected valid syntax`
    return `Unexpected ${encountered}; expected ${expectation}`
  }
  if (context === 'statement') return `Unexpected ${encountered} while parsing a statement`
  return `Unexpected ${encountered} while parsing a ${context}`
}

/** Creates the diagnostic associated with one unexpected-token error node. */
export const unexpectedTokens = <L>(
  unexpected: ReadonlyArray<Token.TokenKind>,
  context: ParserContext,
  expected: ReadonlyArray<string>,
  span: L,
): Diagnostic<L> => {
  const firstUnexpected = unexpected[0]
  const encountered =
    firstUnexpected === undefined || firstUnexpected === 'Invalid'
      ? 'invalid token'
      : Token.describe(firstUnexpected)
  const expectations = [...expected]
  const expectation = expectations[0]
  return {
    _tag: 'Diagnostic',
    phase: 'parser',
    code: unexpectedTokensCode,
    severity: 'error',
    message: unexpectedTokensMessage(encountered, context, expectation),
    reason: {
      _tag: 'UnexpectedTokens' as const,
      unexpected: [...unexpected],
      context,
      expected: expectations,
    },
    span,
    ...(context === 'syntax' || expectations.length === 0
      ? {}
      : { notes: [`Expected one of: ${expectations.join(', ')}`] }),
  }
}

/** Creates the diagnostic for a future template expression start in primary position. */
export const reservedTemplateSyntax = <L>(span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'parser',
  code: reservedTemplateSyntaxCode,
  severity: 'error',
  message: 'Template syntax is reserved but not implemented',
  reason: { _tag: 'ReservedTemplateSyntax' as const },
  span,
})

/** Creates the parser diagnostic for the first token of an over-budget child expression. */
export const expressionNestingLimitExceeded = <L>(
  limit: number,
  attemptedDepth: number,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'parser',
  code: expressionNestingLimitExceededCode,
  severity: 'error',
  message: `Expression nesting exceeds the supported limit of ${limit}`,
  reason: {
    _tag: 'ExpressionNestingLimitExceeded' as const,
    limit,
    attemptedDepth,
  },
  span,
})

/** Creates the diagnostic for a reserved final import segment without a usable binding form. */
export const reservedImportBinding = <L>(spelling: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'parser',
  code: reservedImportBindingCode,
  severity: 'error',
  message: `Reserved module segment ${spelling} requires an explicit alias or selected-member list`,
  reason: { _tag: 'ReservedImportBinding' as const, spelling },
  span,
})

/** Creates the diagnostic for an import whose target module is not supplied. */
export const unknownModule = <L>(module: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'module',
  code: unknownModuleCode,
  severity: 'error',
  message: `Unknown module ${module}`,
  reason: { _tag: 'UnknownModule' as const, module },
  span,
})

/** Creates the diagnostic for an import redundantly naming its own module. */
export const selfImport = <L>(module: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'module',
  code: selfImportCode,
  severity: 'error',
  message: `Module ${module} imports itself`,
  reason: { _tag: 'SelfImport' as const, module },
  span,
})

export const unknownImportedMember = <L>(
  module: string,
  spelling: string,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: unknownImportedMemberCode,
  severity: 'error',
  message: `Module ${module} has no member ${spelling}`,
  reason: { _tag: 'UnknownImportedMember' as const, module, spelling },
  span,
})

export const inaccessibleImportedMember = <L>(
  module: string,
  spelling: string,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: inaccessibleImportedMemberCode,
  severity: 'error',
  message: `${module}.${spelling} is private`,
  reason: { _tag: 'InaccessibleImportedMember' as const, module, spelling },
  span,
})

export const bindingConflict = <L>(spelling: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: bindingConflictCode,
  severity: 'error',
  message: `Multiple bindings claim ${spelling}`,
  reason: { _tag: 'BindingConflict' as const, spelling },
  span,
})

/** Creates the diagnostic for a field name repeated within one struct. */
export const duplicateFieldName = <L>(
  spelling: string,
  originalSpan: L,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: duplicateFieldNameCode,
  severity: 'error',
  message: `Duplicate field name ${spelling}`,
  reason: { _tag: 'DuplicateFieldName' as const, spelling, originalSpan },
  span,
  relatedSpans: [{ label: 'first declared here', span: originalSpan }],
})

/** Creates the diagnostic for a scalar enum with no members. */
export const emptyEnum = <L>(enumName: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: emptyEnumCode,
  severity: 'error',
  message: `Enum ${enumName} must declare at least one member`,
  reason: { _tag: 'EmptyEnum' as const, enum: enumName },
  span,
})

/** Creates the diagnostic for a nominal union with no variants. */
export const emptyNominalUnion = <L>(unionName: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: emptyNominalUnionCode,
  severity: 'error',
  message: `Union ${unionName} must declare at least one variant`,
  reason: { _tag: 'EmptyNominalUnion' as const, union: unionName },
  span,
})

/** Creates the diagnostic for a repeated variant name within one nominal union. */
export const duplicateUnionVariant = <L>(
  spelling: string,
  originalSpan: L,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: duplicateUnionVariantCode,
  severity: 'error',
  message: `Duplicate union variant ${spelling}`,
  reason: { _tag: 'DuplicateUnionVariant' as const, spelling, originalSpan },
  span,
  relatedSpans: [{ label: 'first declared here', span: originalSpan }],
})

/** Creates the diagnostic for braces used without any named variant field. */
export const emptyUnionVariant = <L>(variantName: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: emptyUnionVariantCode,
  severity: 'error',
  message: `Union variant ${variantName} must omit braces or declare at least one field`,
  reason: { _tag: 'EmptyUnionVariant' as const, variant: variantName },
  span,
})

/** Creates the diagnostic for selecting a missing variant from a resolved nominal union. */
export const unknownUnionVariant = <L>(
  unionName: string,
  variantName: string,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: unknownUnionVariantCode,
  severity: 'error',
  message: `Union ${unionName} has no variant ${variantName}`,
  reason: {
    _tag: 'UnknownUnionVariant' as const,
    union: unionName,
    variant: variantName,
  },
  span,
})

/** Creates the diagnostic for a variant qualifier that is not a nominal union. */
export const expectedNominalUnion = <L>(actual: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: expectedNominalUnionCode,
  severity: 'error',
  message: `Expected a nominal union, found ${actual}`,
  reason: { _tag: 'ExpectedNominalUnion' as const, actual },
  span,
})

/** Creates the construction fence for a nominal union with invalid declaration facts. */
export const invalidNominalUnionConstruction = <L>(unionName: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: invalidNominalUnionConstructionCode,
  severity: 'error',
  message: `Cannot construct invalid nominal union ${unionName}`,
  reason: { _tag: 'InvalidNominalUnionConstruction' as const, union: unionName },
  span,
})

export const unsupportedEnumRepresentation = <L>(
  spelling: string,
  allowed: ReadonlyArray<string>,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: unsupportedEnumRepresentationCode,
  severity: 'error',
  message: `${spelling} is not a scalar enum representation`,
  reason: {
    _tag: 'UnsupportedEnumRepresentation' as const,
    spelling,
    allowed: [...allowed],
  },
  span,
})

export const duplicateEnumMemberName = <L>(
  spelling: string,
  originalSpan: L,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: duplicateEnumMemberNameCode,
  severity: 'error',
  message: `Duplicate enum member name ${spelling}`,
  reason: { _tag: 'DuplicateEnumMemberName' as const, spelling, originalSpan },
  span,
  relatedSpans: [{ label: 'first declared here', span: originalSpan }],
})

export const duplicateEnumDiscriminant = <L>(
  value: bigint,
  originalSpan: L,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: duplicateEnumDiscriminantCode,
  severity: 'error',
  message: `Duplicate enum discriminant ${value}`,
  reason: {
    _tag: 'DuplicateEnumDiscriminant' as const,
    value: value.toString(),
    originalSpan,
  },
  span,
  relatedSpans: [{ label: 'first declared here', span: originalSpan }],
})

export const enumDiscriminantOutOfRange = <L>(
  representation: string,
  value: bigint,
  minimum: bigint,
  maximum: bigint,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: enumDiscriminantOutOfRangeCode,
  severity: 'error',
  message: `Enum discriminant ${value} is outside ${representation}`,
  reason: {
    _tag: 'EnumDiscriminantOutOfRange' as const,
    representation,
    value: value.toString(),
    minimum: minimum.toString(),
    maximum: maximum.toString(),
  },
  span,
})

export const enumImplicitDiscriminantOverflow = <L>(
  representation: string,
  predecessor: bigint,
  maximum: bigint,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: enumImplicitDiscriminantOverflowCode,
  severity: 'error',
  message: `Implicit enum discriminant after ${predecessor} exceeds ${representation}`,
  reason: {
    _tag: 'EnumImplicitDiscriminantOverflow' as const,
    representation,
    predecessor: predecessor.toString(),
    maximum: maximum.toString(),
  },
  span,
})

export const unsignedEnumNegativeDiscriminant = <L>(
  representation: string,
  value: bigint,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: unsignedEnumNegativeDiscriminantCode,
  severity: 'error',
  message: `Unsigned enum representation ${representation} cannot hold ${value}`,
  reason: {
    _tag: 'UnsignedEnumNegativeDiscriminant' as const,
    representation,
    value: value.toString(),
  },
  span,
})

export const unknownEnumMember = <L>(enumName: string, member: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: unknownEnumMemberCode,
  severity: 'error',
  message: `Enum ${enumName} has no member ${member}`,
  reason: { _tag: 'UnknownEnumMember' as const, enum: enumName, member },
  span,
})

export const wrongEnumMember = <L>(expected: string, actual: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: wrongEnumMemberCode,
  severity: 'error',
  message: `Enum member of ${actual} cannot be used as ${expected}`,
  reason: { _tag: 'WrongEnumMember' as const, expected, actual },
  span,
})

export const enumIntegerMismatch = <L>(
  enumName: string,
  integer: string,
  direction: 'IntegerToEnum' | 'EnumToInteger',
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: enumIntegerMismatchCode,
  severity: 'error',
  message:
    direction === 'IntegerToEnum'
      ? `${integer} does not implicitly construct ${enumName}`
      : `${enumName} does not implicitly convert to ${integer}`,
  reason: {
    _tag: 'EnumIntegerMismatch' as const,
    enum: enumName,
    integer,
    direction,
  },
  span,
})

export const crossEnumEquality = <L>(left: string, right: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: crossEnumEqualityCode,
  severity: 'error',
  message: `Equality requires one enum type, not ${left} and ${right}`,
  reason: { _tag: 'CrossEnumEquality' as const, left, right },
  span,
})

export const enumOrdering = <L>(enumName: string, operator: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: enumOrderingCode,
  severity: 'error',
  message: `Enum ${enumName} does not support ${operator}; compare backing values explicitly`,
  reason: { _tag: 'EnumOrdering' as const, enum: enumName, operator },
  span,
})

/** Creates the diagnostic for a value declaration used as a declared type. */
export const expectedType = <L>(spelling: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: expectedTypeCode,
  severity: 'error',
  message: `Expected a type, found ${spelling}`,
  reason: { _tag: 'ExpectedType' as const, spelling },
  span,
})

/** Creates the diagnostic for a public contract exposing a private nominal type. */
export const privateTypeExposure = <L>(type: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: privateTypeExposureCode,
  severity: 'error',
  message: `Public declaration exposes private type ${type}`,
  reason: { _tag: 'PrivateTypeExposure' as const, type },
  span,
})

/** Creates the one canonical diagnostic for an inline recursive nominal-aggregate component. */
export const inlineRecursiveAggregate = <L>(
  members: ReadonlyArray<string>,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: inlineRecursiveAggregateCode,
  severity: 'error',
  message: `Inline recursive aggregate layout: ${members.join(' -> ')}`,
  reason: {
    _tag: 'InlineRecursiveAggregate' as const,
    members: [...members],
  },
  span,
})

/** Reports one alias on a cycle, relating every other alias declaration on that cycle. */
export const cyclicTypeAlias = <L>(
  alias: string,
  aliases: ReadonlyArray<string>,
  related: ReadonlyArray<L>,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: cyclicTypeAliasCode,
  severity: 'error',
  message: `Type alias ${alias} is cyclic: ${[...aliases, aliases[0] ?? alias].join(' -> ')}`,
  reason: {
    _tag: 'CyclicTypeAlias' as const,
    aliases: [...aliases],
  },
  span,
  ...(related.length === 0
    ? {}
    : {
        relatedSpans: related.map((relatedSpan) => ({
          label: 'alias on the same cycle',
          span: relatedSpan,
        })),
      }),
})

/** Rejects a type alias that declares type parameters. */
export const typeAliasParameters = <L>(alias: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: typeAliasParametersCode,
  severity: 'error',
  message: `Type alias ${alias} cannot declare type parameters; alias an applied type such as Point<i32> instead`,
  reason: { _tag: 'TypeAliasParameters' as const, alias },
  span,
})

/** Rejects the ABI string of a foreign function declaration; only "C" is supported. */
export const unsupportedForeignAbi = <L>(abi: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: unsupportedForeignAbiCode,
  severity: 'error',
  message: `Foreign ABI "${abi}" is not supported; only "C" is available`,
  reason: { _tag: 'UnsupportedForeignAbi' as const, abi },
  span,
})

/** Rejects a parameterized record before it can publish a C-layout promise. */
export const genericCLayoutRecord = <L>(record: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: genericCLayoutRecordCode,
  severity: 'error',
  message: `C-layout record ${record} cannot declare type parameters`,
  reason: { _tag: 'GenericCLayoutRecord' as const, record },
  span,
})

/** Rejects one field whose resolved type has no supported C object representation. */
export const unsupportedCLayoutField = <L>(
  record: string,
  field: string,
  type: string,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: unsupportedCLayoutFieldCode,
  severity: 'error',
  message: `Field ${field} of C-layout record ${record} has unsupported type ${type}`,
  reason: { _tag: 'UnsupportedCLayoutField' as const, record, field, type },
  span,
})

export const foreignFunctionRequiresUnsafe = <L>(name: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: foreignFunctionRequiresUnsafeCode,
  severity: 'error',
  message: `Foreign function ${name} must be declared unsafe`,
  reason: { _tag: 'ForeignFunctionRequiresUnsafe' as const, name },
  span,
})

/** Reported at the offending parameter or result type of a foreign function. */
export const foreignTypeNotAdmitted = <L>(type: string, abi: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: foreignTypeNotAdmittedCode,
  severity: 'error',
  message: `${type} is not admitted by the ${abi} ABI`,
  reason: { _tag: 'ForeignTypeNotAdmitted' as const, type, abi },
  span,
})

/** Reported at retained Silk-only syntax such as type parameters, rows, `effect`, or a body. */
export const foreignDeclarationRestriction = <L>(restriction: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: foreignDeclarationRestrictionCode,
  severity: 'error',
  message: `A foreign function declaration must not include ${restriction}`,
  reason: { _tag: 'ForeignDeclarationRestriction' as const, restriction },
  span,
})

export const foreignFunctionNotFirstClass = <L>(name: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: foreignFunctionNotFirstClassCode,
  severity: 'error',
  message: `Foreign function ${name} can only be called; it cannot be used as a first-class value`,
  reason: { _tag: 'ForeignFunctionNotFirstClass' as const, name },
  span,
})

export const invalidForeignCallback = <L>(
  name: string,
  detail: string,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: invalidForeignCallbackCode,
  severity: 'error',
  message: `${name} cannot be used as a C callback: ${detail}`,
  reason: { _tag: 'InvalidForeignCallback' as const, name, detail },
  span,
})

export const missingDiagnosticContext = <L>(span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: missingDiagnosticContextCode,
  severity: 'error',
  message: 'Terminal diagnostic observation requires a selected failure context',
  reason: { _tag: 'MissingDiagnosticContext' as const },
  span,
})

export const invalidDiagnosticObserver = <L>(detail: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: invalidDiagnosticObserverCode,
  severity: 'error',
  message: `Diagnostic observer callback requires direct execution: ${detail}`,
  reason: { _tag: 'InvalidDiagnosticObserver' as const, detail },
  span,
})

export const foreignStaticTargetUnavailable = <L>(
  symbol: string,
  surface: string,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: foreignStaticTargetUnavailableCode,
  severity: 'error',
  message: `Foreign static ${symbol} is unavailable on ${surface}; C data symbols require native LLVM linkage`,
  reason: { _tag: 'ForeignStaticTargetUnavailable' as const, symbol, surface },
  span,
})

export const invalidForeignSymbol = <L>(symbol: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: invalidForeignSymbolCode,
  severity: 'error',
  message: `"${symbol}" is not a valid native symbol; use a letter or underscore followed by letters, digits, or underscores`,
  reason: { _tag: 'InvalidForeignSymbol' as const, symbol },
  span,
})

export const reservedForeignSymbol = <L>(symbol: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: reservedForeignSymbolCode,
  severity: 'error',
  message: `Native symbol ${symbol} is reserved by the compiler runtime`,
  reason: { _tag: 'ReservedForeignSymbol' as const, symbol },
  span,
})

/** Relates the other reachable declaration of the same symbol. */
export const conflictingForeignSignature = <L>(
  symbol: string,
  span: L,
  otherSpan: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: conflictingForeignSignatureCode,
  severity: 'error',
  message: `Foreign symbol ${symbol} is declared with a conflicting C signature or behavioral contract`,
  reason: { _tag: 'ConflictingForeignSignature' as const, symbol, otherSpan },
  span,
  relatedSpans: [{ label: 'conflicting declaration', span: otherSpan }],
})

/** Diagnoses a reachable foreign call before an execution surface without bindings is entered. */
export const foreignFunctionTargetUnavailable = <L>(
  symbol: string,
  surface: string,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: foreignFunctionTargetUnavailableCode,
  severity: 'error',
  message: `Foreign function ${symbol} is unavailable for ${surface}`,
  reason: { _tag: 'ForeignFunctionTargetUnavailable' as const, symbol, surface },
  span,
})

const inherentHeadMessage = (
  owner: string,
  problem: 'Specialized' | 'Bounded' | 'ForeignOwner' | 'AliasOwner' | 'NotNominal',
): string => {
  switch (problem) {
    case 'Specialized':
      return `impl ${owner} must name the whole type family: its arguments are exactly the impl's own binders, in order, each once`
    case 'Bounded':
      return `impl ${owner} cannot bound its binders; inherent members belong to every instantiation`
    case 'ForeignOwner':
      return `impl ${owner} must be declared in the module that declares ${owner}`
    case 'AliasOwner':
      return `impl ${owner} cannot use a type alias as its owner; name the aliased nominal type instead`
    case 'NotNominal':
      return `impl ${owner} must name a struct, union, enum, service, or interface declaration`
  }
}

/** Rejects an inherent impl head that does not own the complete family of a module-local nominal. */
export const invalidInherentHead = <L>(
  owner: string,
  problem: 'Specialized' | 'Bounded' | 'ForeignOwner' | 'AliasOwner' | 'NotNominal',
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: invalidInherentHeadCode,
  severity: 'error',
  message: inherentHeadMessage(owner, problem),
  reason: { _tag: 'InvalidInherentHead' as const, owner, problem },
  span,
})

const inherentMemberMessage = (
  owner: string,
  member: string,
  problem: 'MappedOperation' | 'DropHook' | 'Collision',
  collidesWith: string | undefined,
): string => {
  switch (problem) {
    case 'MappedOperation':
      return `impl ${owner} cannot map ${member} to another declaration; only a conformance maps operations`
    case 'DropHook':
      return `impl ${owner} cannot declare a drop hook; declare impl Drop for ${owner} instead`
    case 'Collision':
      return `${owner}.${member} collides with the ${collidesWith ?? 'existing item'} ${member} of ${owner}`
  }
}

/** Rejects an inherent impl member that cannot become an associated member of its owner. */
export const invalidInherentMember = <L>(
  owner: string,
  member: string,
  problem: 'MappedOperation' | 'DropHook' | 'Collision',
  span: L,
  collidesWith?: string,
  relatedSpan?: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: invalidInherentMemberCode,
  severity: 'error',
  message: inherentMemberMessage(owner, member, problem, collidesWith),
  reason: {
    _tag: 'InvalidInherentMember' as const,
    owner,
    member,
    problem,
    ...(collidesWith === undefined ? {} : { collidesWith }),
  },
  span,
  ...(relatedSpan === undefined
    ? {}
    : {
        relatedSpans: [{ label: `${collidesWith ?? 'item'} ${member}`, span: relatedSpan }],
      }),
})

/** Rejects a second inherent member of one owner with a name an earlier impl block already used. */
export const duplicateInherentMember = <L>(
  owner: string,
  member: string,
  span: L,
  otherSpan: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: duplicateInherentMemberCode,
  severity: 'error',
  message: `${owner}.${member} is declared more than once; one owner has at most one member of each name`,
  reason: { _tag: 'DuplicateInherentMember' as const, owner, member },
  span,
  relatedSpans: [{ label: `other declaration of ${owner}.${member}`, span: otherSpan }],
})

/** Rejects a selective import that names an inherent member as though it were a root declaration. */
export const importedInherentMember = <L>(
  module: string,
  member: string,
  owner: string,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: importedInherentMemberCode,
  severity: 'error',
  message: `${module} has no root declaration ${member}; it is a member of ${owner}, so import ${owner} and write ${owner}.${member}`,
  reason: { _tag: 'ImportedInherentMember' as const, module, member, owner },
  span,
})

/** Rejects `value.member(...)` when `member` is an associated function that declares no receiver. */
export const associatedFunctionOnValue = <L>(
  owner: string,
  member: string,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: associatedFunctionOnValueCode,
  severity: 'error',
  message: `${owner}.${member} is an associated function without a receiver; call it as ${owner}.${member}(...)`,
  reason: { _tag: 'AssociatedFunctionOnValue' as const, owner, member },
  span,
})

/** Rejects `value.member(...)` on a type parameter whose bounds declare `member` more than once. */
export const ambiguousReceiverOperation = <L>(
  parameter: string,
  member: string,
  interfaces: ReadonlyArray<string>,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: ambiguousReceiverOperationCode,
  severity: 'error',
  message: `${member} is declared by more than one bound of ${parameter} (${interfaces.join(', ')}); call it through the bound, as ${interfaces.at(0) ?? 'Bound'}.${member}(...)`,
  reason: {
    _tag: 'AmbiguousReceiverOperation' as const,
    parameter,
    member,
    interfaces: [...interfaces],
  },
  span,
})

/**
 * Creates the diagnostic for a receiver operation more than one of the receiver's conformances
 * supplies.
 *
 * The receiver spelling names only the operation, so a type conforming to two interfaces that both
 * declare that name leaves the call naming no single application. Both operations are real and both
 * conformances are proved; what is missing is which one the call means. Arguments must not choose,
 * so the qualified spelling is the answer.
 */
export const ambiguousSuppliedOperation = <L>(
  receiver: string,
  member: string,
  interfaces: ReadonlyArray<string>,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: ambiguousSuppliedOperationCode,
  severity: 'error',
  message: `${member} is supplied to ${receiver} by more than one interface (${interfaces.join(', ')}); call it through one, as ${interfaces.at(0) ?? 'Interface'}.${member}(...)`,
  reason: {
    _tag: 'AmbiguousSuppliedOperation' as const,
    receiver,
    member,
    interfaces: [...interfaces],
  },
  span,
})

/**
 * Creates the diagnostic for naming a conformance-supplied receiver operation as a value.
 *
 * The operation is a real member and calling it resolves, but a first-class value of it would have
 * to carry the conformance witness its call selects statically. That is a separate capability, so
 * the operation is available only in callee position.
 */
export const suppliedOperationValue = <L>(
  receiver: string,
  member: string,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: suppliedOperationValueCode,
  severity: 'error',
  message: `${member} is supplied to ${receiver} by an interface and must be called; it has no value form`,
  reason: { _tag: 'SuppliedOperationValue' as const, receiver, member },
  span,
})

export const inaccessibleStructConstruction = <L>(type: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: inaccessibleStructConstructionCode,
  severity: 'error',
  message: `Cannot construct ${type} because its raw constructor is not available at this site`,
  reason: { _tag: 'InaccessibleStructConstruction' as const, type },
  span,
})

export const unknownStructField = <L>(type: string, field: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: unknownStructFieldCode,
  severity: 'error',
  message: `${type} has no field ${field}`,
  reason: { _tag: 'UnknownStructField' as const, type, field },
  span,
})

export const duplicateStructInitializer = <L>(
  field: string,
  originalSpan: L,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: duplicateStructInitializerCode,
  severity: 'error',
  message: `Field ${field} is initialized more than once`,
  reason: { _tag: 'DuplicateStructInitializer' as const, field, originalSpan },
  span,
  relatedSpans: [{ label: 'first initialized here', span: originalSpan }],
})

export const missingStructInitializer = <L>(
  type: string,
  field: string,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: missingStructInitializerCode,
  severity: 'error',
  message: `Missing initializer for ${type}.${field}`,
  reason: { _tag: 'MissingStructInitializer' as const, type, field },
  span,
})

export const structFieldTypeMismatch = <L>(
  field: string,
  expected: string,
  actual: string,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: structFieldTypeMismatchCode,
  severity: 'error',
  message: `Field ${field} expects ${expected} but received ${actual}`,
  reason: { _tag: 'StructFieldTypeMismatch' as const, field, expected, actual },
  span,
})

export const conflictingInitializerRepresentation = <L>(
  parameter: string,
  expected: string,
  actual: string,
  originalSpan: L,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: conflictingInitializerRepresentationCode,
  severity: 'error',
  message: `Representation ${parameter} was inferred as ${expected}, but this initializer uses ${actual}`,
  reason: {
    _tag: 'ConflictingInitializerRepresentation' as const,
    parameter,
    expected,
    actual,
    originalSpan,
  },
  span,
  relatedSpans: [{ label: 'representation first inferred here', span: originalSpan }],
})

export const projectionOnNonStruct = <L>(actual: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: projectionOnNonStructCode,
  severity: 'error',
  message: `Cannot project a field from ${actual}`,
  reason: { _tag: 'ProjectionOnNonStruct' as const, actual },
  span,
})

export const invalidReferentProjection = <L>(actual: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: invalidReferentProjectionCode,
  severity: 'error',
  message: `Cannot project a referent from ${actual}; the subject must be a reference`,
  reason: { _tag: 'InvalidReferentProjection' as const, actual },
  span,
})

export const unknownProjectedField = <L>(type: string, field: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: unknownProjectedFieldCode,
  severity: 'error',
  message: `${type} has no field ${field}`,
  reason: { _tag: 'UnknownProjectedField' as const, type, field },
  span,
})

export const inaccessibleProjectedField = <L>(
  type: string,
  field: string,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: inaccessibleProjectedFieldCode,
  severity: 'error',
  message: `${type}.${field} is private`,
  reason: { _tag: 'InaccessibleProjectedField' as const, type, field },
  span,
})

export const emptyArrayNeedsContext = <L>(span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: emptyArrayNeedsContextCode,
  severity: 'error',
  message: 'An empty array literal needs an expected Array type',
  reason: { _tag: 'EmptyArrayNeedsContext' as const },
  span,
})

export const arrayElementTypeMismatch = <L>(
  expected: string,
  actual: string,
  index: number,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: arrayElementTypeMismatchCode,
  severity: 'error',
  message: `Array element ${index} expects ${expected} but received ${actual}`,
  reason: { _tag: 'ArrayElementTypeMismatch' as const, expected, actual, index },
  span,
})

export const arrayLengthMismatch = <L>(
  expected: number,
  actual: number,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: arrayLengthMismatchCode,
  severity: 'error',
  message: `Array literal expects ${expected} elements but received ${actual}`,
  reason: { _tag: 'ArrayLengthMismatch' as const, expected, actual },
  span,
})

export const indexOnNonArray = <L>(actual: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: indexOnNonArrayCode,
  severity: 'error',
  message: `Cannot index ${actual}`,
  reason: { _tag: 'IndexOnNonArray' as const, actual },
  span,
})

export const indexNotUsize = <L>(actual: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: indexNotUsizeCode,
  severity: 'error',
  message: `Array index must be usize, found ${actual}`,
  reason: { _tag: 'IndexNotUsize' as const, actual },
  span,
})

export const indexOutOfBounds = <L>(index: number, length: number, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: indexOutOfBoundsCode,
  severity: 'error',
  message: `Array index ${index} is outside length ${length}`,
  reason: { _tag: 'IndexOutOfBounds' as const, index, length },
  span,
})

/** Creates the diagnostic for one present identifier that cannot resolve as a type. */
export const unknownType = <L>(spelling: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: unknownTypeCode,
  severity: 'error',
  message: `Unknown type ${spelling}`,
  reason: { _tag: 'UnknownType' as const, spelling },
  span,
})

/** Creates a range diagnostic with the selected integer type and exact decimal bounds. */
export const integerOutOfRange = <L>(
  spelling: string,
  type: string,
  range: { readonly minimum: bigint; readonly maximum: bigint },
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: integerOutOfRangeCode,
  severity: 'error',
  message: `Integer literal ${spelling} exceeds the ${type} range ${range.minimum} through ${range.maximum}`,
  reason: {
    _tag: 'IntegerOutOfRange' as const,
    spelling,
    type,
    maximum: range.maximum.toString(),
    minimum: range.minimum.toString(),
  },
  span,
})

/** Creates the semantic diagnostic for a duration total outside the fixed `u64` domain. */
export const durationOutOfRange = <L>(spelling: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: durationOutOfRangeCode,
  severity: 'error',
  message: 'Duration literal exceeds the u64 nanosecond range',
  reason: {
    _tag: 'DurationOutOfRange' as const,
    spelling,
    maximum: '18446744073709551615',
  },
  span,
})

export const tupleArityMismatch = <L>(
  type: string,
  expected: number,
  actual: number,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: tupleArityMismatchCode,
  severity: 'error',
  message: `${type} expects ${expected} tuple elements but received ${actual}`,
  reason: { _tag: 'TupleArityMismatch' as const, type, expected, actual },
  span,
})

export const contextualAggregateKindMismatch = <L>(
  expected: 'record' | 'tuple',
  actual: string,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: contextualAggregateKindMismatchCode,
  severity: 'error',
  message: `A contextual ${expected} literal cannot construct ${actual}`,
  reason: { _tag: 'ContextualAggregateKindMismatch' as const, expected, actual },
  span,
})

export const anonymousAggregateJoinMismatch = <L>(
  types: ReadonlyArray<string>,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: anonymousAggregateJoinMismatchCode,
  severity: 'error',
  message: 'Separate anonymous aggregate occurrences do not acquire a common type',
  reason: { _tag: 'AnonymousAggregateJoinMismatch' as const, types },
  span,
})

export const positionalFieldConstruction = <L>(type: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: positionalFieldConstructionCode,
  severity: 'error',
  message: `${type} is positional and cannot be constructed with named fields`,
  reason: { _tag: 'PositionalFieldConstruction' as const, type },
  span,
})

const freezeStaticTrace = <L>(
  trace: ReadonlyArray<StaticTraceFrame<L>>,
): ReadonlyArray<StaticTraceFrame<L>> =>
  trace.map((frame) => ({
    ...frame,
    arguments: Array.from(frame.arguments),
  }))

const staticTraceRelatedSpans = <L>(
  trace: ReadonlyArray<StaticTraceFrame<L>>,
): ReadonlyArray<RelatedSpan<L>> => trace.map((frame) => ({ label: frame.label, span: frame.span }))

/** Creates a diagnostic for one operation unavailable during static evaluation. */
export const staticPhaseViolation = <L>(
  operation: string,
  target: string,
  trace: ReadonlyArray<StaticTraceFrame<L>>,
  span: L,
): Diagnostic<L> => {
  const frozenTrace = freezeStaticTrace(trace)
  return {
    _tag: 'Diagnostic',
    phase: 'semantic',
    code: staticPhaseViolationCode,
    severity: 'error',
    message: `${operation} is not available during static evaluation for ${target}`,
    reason: {
      _tag: 'StaticPhaseViolation' as const,
      operation,
      target,
      trace: frozenTrace,
    },
    span,
    relatedSpans: staticTraceRelatedSpans(frozenTrace),
  }
}

/** Creates the diagnostic requested by a selected `compileError` expression. */
export const selectedCompileError = <L>(
  detail: string,
  target: string,
  trace: ReadonlyArray<StaticTraceFrame<L>>,
  span: L,
): Diagnostic<L> => {
  const frozenTrace = freezeStaticTrace(trace)
  return {
    _tag: 'Diagnostic',
    phase: 'semantic',
    code: selectedCompileErrorCode,
    severity: 'error',
    message: `${detail}`,
    reason: {
      _tag: 'SelectedCompileError' as const,
      detail,
      target,
      trace: frozenTrace,
    },
    span,
    relatedSpans: staticTraceRelatedSpans(frozenTrace),
  }
}

/** Creates a diagnostic for a cyclic demanded static application. */
export const staticEvaluationCycle = <L>(
  application: string,
  target: string,
  trace: ReadonlyArray<StaticTraceFrame<L>>,
  span: L,
): Diagnostic<L> => {
  const frozenTrace = freezeStaticTrace(trace)
  return {
    _tag: 'Diagnostic',
    phase: 'semantic',
    code: staticEvaluationCycleCode,
    severity: 'error',
    message: `Static evaluation of ${application} is cyclic for ${target}`,
    reason: {
      _tag: 'StaticEvaluationCycle' as const,
      application,
      target,
      trace: frozenTrace,
    },
    span,
    relatedSpans: staticTraceRelatedSpans(frozenTrace),
  }
}

/** Creates a diagnostic for exhaustion of the deterministic static step budget. */
export const staticStepLimit = <L>(
  limit: number,
  target: string,
  trace: ReadonlyArray<StaticTraceFrame<L>>,
  span: L,
): Diagnostic<L> => {
  const frozenTrace = freezeStaticTrace(trace)
  return {
    _tag: 'Diagnostic',
    phase: 'semantic',
    code: staticStepLimitCode,
    severity: 'error',
    message: `Static evaluation exceeded its step limit of ${limit} for ${target}`,
    reason: {
      _tag: 'StaticEvaluationLimit' as const,
      resource: 'Steps',
      limit,
      target,
      trace: frozenTrace,
    },
    span,
    relatedSpans: staticTraceRelatedSpans(frozenTrace),
  }
}

/** Creates a diagnostic for exhaustion of the logical static call-depth budget. */
export const staticCallDepthLimit = <L>(
  limit: number,
  target: string,
  trace: ReadonlyArray<StaticTraceFrame<L>>,
  span: L,
): Diagnostic<L> => {
  const frozenTrace = freezeStaticTrace(trace)
  return {
    _tag: 'Diagnostic',
    phase: 'semantic',
    code: staticCallDepthLimitCode,
    severity: 'error',
    message: `Static evaluation exceeded its call-depth limit of ${limit} for ${target}`,
    reason: {
      _tag: 'StaticEvaluationLimit' as const,
      resource: 'CallDepth',
      limit,
      target,
      trace: frozenTrace,
    },
    span,
    relatedSpans: staticTraceRelatedSpans(frozenTrace),
  }
}

/** Creates a diagnostic for exhaustion of retained canonical static-value bytes. */
export const staticRetainedValueLimit = <L>(
  limit: number,
  target: string,
  trace: ReadonlyArray<StaticTraceFrame<L>>,
  span: L,
): Diagnostic<L> => {
  const frozenTrace = freezeStaticTrace(trace)
  return {
    _tag: 'Diagnostic',
    phase: 'semantic',
    code: staticRetainedValueLimitCode,
    severity: 'error',
    message: `Static evaluation exceeded its retained-value limit of ${limit} bytes for ${target}`,
    reason: {
      _tag: 'StaticEvaluationLimit' as const,
      resource: 'RetainedValueBytes',
      limit,
      target,
      trace: frozenTrace,
    },
    span,
    relatedSpans: staticTraceRelatedSpans(frozenTrace),
  }
}

/** Creates a diagnostic for exhaustion of residual TIR growth. */
export const staticResidualGrowthLimit = <L>(
  limit: number,
  target: string,
  trace: ReadonlyArray<StaticTraceFrame<L>>,
  span: L,
): Diagnostic<L> => {
  const frozenTrace = freezeStaticTrace(trace)
  return {
    _tag: 'Diagnostic',
    phase: 'semantic',
    code: staticResidualGrowthLimitCode,
    severity: 'error',
    message: `Static evaluation exceeded its residual-growth limit of ${limit} nodes for ${target}`,
    reason: {
      _tag: 'StaticEvaluationLimit' as const,
      resource: 'ResidualNodes',
      limit,
      target,
      trace: frozenTrace,
    },
    span,
    relatedSpans: staticTraceRelatedSpans(frozenTrace),
  }
}

/** Creates the target-independent diagnostic for a negative `usize` literal. */
export const usizeNegative = <L>(spelling: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: usizeNegativeCode,
  severity: 'error',
  message: 'usize literals cannot be negative',
  reason: { _tag: 'UsizeNegative' as const, spelling },
  span,
})

/** Creates the diagnostic for a type that cannot inhabit an Effect failure channel. */
export const invalidFailureType = <L>(type: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: invalidFailureTypeCode,
  severity: 'error',
  message: `Effect failure ${type} must be a detached ordinary value type`,
  reason: { _tag: 'InvalidFailureType' as const, type },
  span,
})

/** Creates the diagnostic for a requirement that cannot name one dependency-eligible service. */
export const invalidRequirementType = <L>(type: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: invalidRequirementTypeCode,
  severity: 'error',
  message: `Effect requirement ${type} must be one concrete service type`,
  reason: { _tag: 'InvalidRequirementType' as const, type },
  span,
})

/** Creates the diagnostic for spelling a failure channel on a direct ordinary function. */
export const failureChannelOnOrdinary = <L>(span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: failureChannelOnOrdinaryCode,
  severity: 'error',
  message: 'Only effect functions may declare a failure channel',
  reason: { _tag: 'FailureChannelOnOrdinary' as const },
  span,
})

export const failOutsideEffect = <L>(span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: failOutsideEffectCode,
  severity: 'error',
  message: 'Only effect functions may originate a typed failure',
  reason: { _tag: 'FailOutsideEffect' as const },
  span,
})

export const undeclaredFailure = <L>(type: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: undeclaredFailureCode,
  severity: 'error',
  message: `Failure ${type} is not declared by this effect function`,
  reason: { _tag: 'UndeclaredFailure' as const, type },
  span,
})

export const runNonEffect = <L>(type: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: runNonEffectCode,
  severity: 'error',
  message: `Cannot run non-effect value ${type}`,
  reason: { _tag: 'RunNonEffect' as const, type },
  span,
})

export const unhandledEffectFailures = <L>(
  failures: ReadonlyArray<string>,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: unhandledEffectFailuresCode,
  severity: 'error',
  message: `Run leaves unhandled failures: ${failures.join(' | ')}`,
  reason: {
    _tag: 'UnhandledEffectFailures' as const,
    failures: failures,
  },
  span,
})

export const unhandledEffectRequirements = <L>(
  requirements: ReadonlyArray<string>,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: unhandledEffectRequirementsCode,
  severity: 'error',
  message: `Run leaves unsatisfied requirements: ${requirements.join(' | ')}`,
  reason: {
    _tag: 'UnhandledEffectRequirements' as const,
    requirements: requirements,
  },
  span,
})

export const invalidEffectProvision = <L>(detail: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: invalidEffectProvisionCode,
  severity: 'error',
  message: `Invalid Effect provider: ${detail}`,
  reason: { _tag: 'InvalidEffectProvision' as const, detail },
  span,
})

/**
 * Rejects a reachable construction that would store a bare callable value inside an aggregate.
 *
 * A direct callable value works because the compiler still holds its hidden concrete identity; an
 * aggregate type such as `Parser` carries only the declared signature, so layout planning cannot
 * size the callable's environment (#184). Until nominal values can carry that identity — or stored
 * callables get a uniform runtime representation — the construction is reported here, at the source
 * site, instead of surfacing later as an `InvalidMir` failure with no user-facing diagnostic.
 *
 * When the aggregate stores a callable only because a generic specialization chose one — the
 * declared field type is a bare type parameter — the primary span is the specializing call site,
 * because that is where the concrete callable argument was written, and the generic body's
 * construction is retained as `constructedAt` related provenance.
 */
export const storedCallableConstruction = <L>(
  aggregate: string,
  field: string | undefined,
  callable: string,
  span: L,
  constructedAt?: L,
  represented = false,
  kind: 'callable' | 'Effect' = 'callable',
): Diagnostic<L> => {
  const site = field === undefined ? 'its element' : `field ${field}`
  return {
    _tag: 'Diagnostic',
    phase: 'semantic',
    code: storedCallableConstructionCode,
    severity: 'error',
    message: represented
      ? `Cannot construct ${aggregate}: ${site} retains the static identity of ${callable}, but represented callable storage has no supported runtime layout`
      : `Cannot construct ${aggregate}: ${site} would store the ${kind} ${callable}, whose environment layout depends on a hidden concrete identity that ${aggregate} does not carry`,
    reason: {
      _tag: 'StoredCallableConstruction' as const,
      aggregate,
      ...(field === undefined ? {} : { field }),
      callable,
    },
    span,
    ...(constructedAt === undefined
      ? {}
      : {
          relatedSpans: [{ label: 'constructed here', span: constructedAt }],
        }),
  }
}

/** What one rejected `typeof` item names instead of an ordinary callable declaration. */
export type UncallableExactRepresentationSubject =
  | 'EffectDeclaration'
  | 'LocalBinding'
  | 'CallableSection'
  | 'NonCallableDeclaration'

const uncallableSubjectProse = (subject: UncallableExactRepresentationSubject): string => {
  switch (subject) {
    case 'EffectDeclaration':
      return 'an Effect declaration rather than an ordinary callable'
    case 'LocalBinding':
      return 'a local binding, which exists only where it is written'
    case 'CallableSection':
      return 'a callable section, whose identity belongs to its construction site'
    case 'NonCallableDeclaration':
      return 'a declaration that is not callable'
  }
}

const opaqueResultNote =
  'Return an opaque representation result instead when the concrete identity must stay private.'

/** Rejects one `typeof` item that names no declaration in the enclosing scope. */
export const unresolvedExactRepresentationItem = <L>(item: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: unresolvedExactRepresentationItemCode,
  severity: 'error',
  message: `Cannot name the exact representation of ${item}: no declaration of that name is in scope`,
  reason: { _tag: 'UnresolvedExactRepresentationItem' as const, item },
  span,
  notes: [opaqueResultNote],
})

/** Rejects one `typeof` item whose name belongs to more than one declaration. */
export const ambiguousExactRepresentationItem = <L>(
  item: string,
  count: number,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: ambiguousExactRepresentationItemCode,
  severity: 'error',
  message: `Cannot name the exact representation of ${item}: ${count} declarations carry that name, so no single item is resolved`,
  reason: { _tag: 'AmbiguousExactRepresentationItem' as const, item, count },
  span,
  notes: [opaqueResultNote],
})

/**
 * Rejects one `typeof` item that names something other than an ordinary callable declaration.
 *
 * Local bindings, callable sections, and Effect construction sites are values created where they
 * are written. They have no declaration-owned identity a contract can name, so their
 * representation can only cross a boundary behind an opaque result.
 */
export const uncallableExactRepresentationItem = <L>(
  item: string,
  subjectKind: UncallableExactRepresentationSubject,
  span: L,
): Diagnostic<L> => {
  const subject = uncallableSubjectProse(subjectKind)
  return {
    _tag: 'Diagnostic',
    phase: 'semantic',
    code: uncallableExactRepresentationItemCode,
    severity: 'error',
    message: `Cannot name the exact representation of ${item}: it names ${subject}, which has no source-nameable exact identity`,
    reason: {
      _tag: 'UncallableExactRepresentationItem' as const,
      item,
      subject: subjectKind,
    },
    span,
    notes: [opaqueResultNote],
  }
}

/** Rejects one `typeof` item whose generic parameters are not all supplied. */
export const openExactRepresentationItem = <L>(
  item: string,
  expected: number,
  actual: number,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: openExactRepresentationItemCode,
  severity: 'error',
  message: `Cannot name the exact representation of ${item}: an exact representation names one construction, but ${expected} generic parameters were declared and ${actual} concrete arguments were supplied`,
  reason: { _tag: 'OpenExactRepresentationItem' as const, item, expected, actual },
  span,
  notes: [opaqueResultNote],
})

/** Rejects a public contract that exposes the exact identity of a less visible item. */
export const privateExactRepresentationLeak = <L>(item: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: privateExactRepresentationLeakCode,
  severity: 'error',
  message: `Public contract exposes the exact representation of private ${item}`,
  reason: { _tag: 'PrivateExactRepresentationLeak' as const, item },
  span,
  notes: [opaqueResultNote],
})

/** Rejects one opaque family whose reachable returns select more than one exact realization. */
export const divergentOpaqueRealization = <L>(
  family: string,
  realizations: ReadonlyArray<string>,
  related: ReadonlyArray<L>,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: divergentOpaqueRealizationCode,
  severity: 'error',
  message: `Opaque result ${family} has divergent reachable realizations: ${realizations.join(', ')}`,
  reason: {
    _tag: 'DivergentOpaqueRealization' as const,
    family,
    realizations: [...realizations],
  },
  span,
  ...(related.length === 0
    ? {}
    : {
        relatedSpans: related.map((candidate) => ({
          label: 'conflicting realization returned here',
          span: candidate,
        })),
      }),
})

/** Rejects opaque families whose only representation evidence is another unresolved family. */
export const opaqueRealizationCycle = <L>(
  families: ReadonlyArray<string>,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: opaqueRealizationCycleCode,
  severity: 'error',
  message: `Opaque realization cycle has no local concrete construction: ${families.join(' -> ')}`,
  reason: {
    _tag: 'OpaqueRealizationCycle' as const,
    families: [...families],
  },
  span,
})

/** Rejects a capture layout that would contain the opaque family it is defining inline. */
export const inlineOpaqueLayoutCycle = <L>(
  families: ReadonlyArray<string>,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: inlineOpaqueLayoutCycleCode,
  severity: 'error',
  message: `Opaque results form an infinite inline layout cycle: ${families.join(' -> ')}`,
  reason: {
    _tag: 'InlineOpaqueLayoutCycle' as const,
    families: [...families],
  },
  span,
})

/** Rejects an opaque result binder whose bound is not a callable or Effect representation. */
export const invalidOpaqueResultBinder = <L>(
  binder: string,
  actual: 'Lifetime' | 'Value' | 'RequirementRow',
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: invalidOpaqueResultBinderCode,
  severity: 'error',
  message: `Opaque result binder ${binder} must have a callable or Effect representation bound, but its kind is ${actual}`,
  reason: { _tag: 'InvalidOpaqueResultBinder' as const, binder, actual },
  span,
})

/** Rejects an opaque producer whose reachable returns select no representation construction. */
export const missingOpaqueRealization = <L>(family: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: missingOpaqueRealizationCode,
  severity: 'error',
  message: `Opaque result ${family} has no reachable callable or Effect representation construction`,
  reason: { _tag: 'MissingOpaqueRealization' as const, family },
  span,
})

/** Rejects an opaque result in a contract-only declaration that has no producer body. */
export const bodylessOpaqueResult = <L>(
  declaration: string,
  contextKind: 'ServiceOperation' | 'InterfaceOperation',
  span: L,
): Diagnostic<L> => {
  const context = contextKind === 'ServiceOperation' ? 'service' : 'interface'
  return {
    _tag: 'Diagnostic',
    phase: 'semantic',
    code: bodylessOpaqueResultCode,
    severity: 'error',
    message: `Opaque result ${declaration} is not permitted on a ${context} operation because no producer body can establish one static representation`,
    reason: {
      _tag: 'BodylessOpaqueResult' as const,
      declaration,
      context: contextKind,
    },
    span,
  }
}

/** Rejects represented Effect storage until a downstream runtime layout has been proven. */
export const storedRepresentedEffectConstruction = <L>(
  aggregate: string,
  field: string | undefined,
  effect: string,
  span: L,
  constructedAt?: L,
): Diagnostic<L> => {
  const site = field === undefined ? 'its element' : `field ${field}`
  return {
    _tag: 'Diagnostic',
    phase: 'semantic',
    code: storedRepresentedEffectConstructionCode,
    severity: 'error',
    message: `Cannot construct ${aggregate}: ${site} retains the static identity of ${effect}, but represented Effect storage has no supported runtime layout`,
    reason: {
      _tag: 'StoredRepresentedEffectConstruction' as const,
      aggregate,
      ...(field === undefined ? {} : { field }),
      effect,
    },
    span,
    ...(constructedAt === undefined
      ? {}
      : {
          relatedSpans: [{ label: 'constructed here', span: constructedAt }],
        }),
  }
}

export const invalidEffectHandler = <L>(detail: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: invalidEffectHandlerCode,
  severity: 'error',
  message: `Invalid Effect.catch handler: ${detail}`,
  reason: { _tag: 'InvalidEffectHandler' as const, detail },
  span,
})

export const mutableEffectRecipe = <L>(span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: mutableEffectRecipeCode,
  severity: 'error',
  message: 'Effect recipe bindings are immutable',
  reason: { _tag: 'MutableEffectRecipe' as const },
  span,
})

export const nonFiniteEffectJoin = <L>(detail: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: nonFiniteEffectJoinCode,
  severity: 'error',
  message: `Cannot form a finite Effect join: ${detail}`,
  reason: { _tag: 'NonFiniteEffectJoin' as const, detail },
  span,
})

export const callableIdentityErasure = <L>(span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: callableIdentityErasureCode,
  severity: 'error',
  message:
    'Cannot merge callable values from different construction sites without explicit erasure',
  reason: { _tag: 'CallableIdentityErasure' as const },
  span,
})

export const unknownOwnedCallableReturn = <L>(span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: unknownOwnedCallableReturnCode,
  severity: 'error',
  message: 'Cannot return an owned callable whose concrete environment identity is unknown',
  reason: { _tag: 'UnknownOwnedCallableReturn' as const },
  span,
})

/** Creates the target-owned diagnostic for a `usize` literal outside its selected word. */
export const wordLiteralTargetOutOfRange = <L>(
  type: 'usize' | 'isize',
  spelling: string,
  target: string,
  bits: 32 | 64,
  span: L,
): Diagnostic<L> => {
  const minimum = type === 'usize' ? 0n : -(1n << BigInt(bits - 1))
  const maximum = type === 'usize' ? (1n << BigInt(bits)) - 1n : (1n << BigInt(bits - 1)) - 1n
  return {
    _tag: 'Diagnostic',
    phase: 'layout',
    code: wordLiteralOutOfRangeCode,
    severity: 'error',
    message: `${type} literal ${spelling} exceeds the ${bits}-bit range for ${target}`,
    reason: {
      _tag: 'WordLiteralOutOfRange' as const,
      type,
      spelling,
      target,
      bits,
      minimum: minimum.toString(),
      maximum: maximum.toString(),
    },
    span,
  }
}

/** Creates the diagnostic for a qualified call naming an unknown built-in actor. */
export const unknownActor = <L>(spelling: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: unknownActorCode,
  severity: 'error',
  message: `Unknown actor ${spelling}`,
  reason: { _tag: 'UnknownActor' as const, spelling },
  span,
})

/** Creates the diagnostic for a known actor called with an unknown operation. */
export const unknownActorOperation = <L>(
  actor: string,
  spelling: string,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: unknownActorOperationCode,
  severity: 'error',
  message: `${actor} has no operation ${spelling}`,
  reason: { _tag: 'UnknownActorOperation' as const, actor, spelling },
  span,
})

/** Creates the diagnostic for a declaration name repeated after its first occurrence. */
export const duplicateDeclarationName = <L>(
  spelling: string,
  originalSpan: L,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: duplicateDeclarationNameCode,
  severity: 'error',
  message: `Duplicate declaration name ${spelling}`,
  reason: {
    _tag: 'DuplicateDeclarationName' as const,
    spelling,
    originalSpan,
  },
  span,
  relatedSpans: [{ label: 'first declared here', span: originalSpan }],
})

/** Creates the diagnostic for one present call name with no matching declaration. */
export const unknownFunction = <L>(spelling: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: unknownFunctionCode,
  severity: 'error',
  message: `Unknown function ${spelling}`,
  reason: { _tag: 'UnknownFunction' as const, spelling },
  span,
})

/** Creates the diagnostic for a parameter name repeated after its first occurrence. */
export const duplicateParameterName = <L>(
  spelling: string,
  originalSpan: L,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: duplicateParameterNameCode,
  severity: 'error',
  message: `Duplicate parameter name ${spelling}`,
  reason: {
    _tag: 'DuplicateParameterName' as const,
    spelling,
    originalSpan,
  },
  span,
  relatedSpans: [{ label: 'first declared here', span: originalSpan }],
})

/** Creates the diagnostic for one present value name with no matching local declaration. */
export const unknownValueReference = <L>(spelling: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: unknownValueReferenceCode,
  severity: 'error',
  message: `Unknown value ${spelling}`,
  reason: { _tag: 'UnknownValueReference' as const, spelling },
  span,
})

/** Creates the diagnostic for a binding name that repeats an existing local declaration. */
export const rebindingName = <L>(spelling: string, originalSpan: L, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: rebindingNameCode,
  severity: 'error',
  message: `Cannot rebind ${spelling}`,
  reason: { _tag: 'RebindingName' as const, spelling, originalSpan },
  span,
  relatedSpans: [{ label: 'first declared here', span: originalSpan }],
})

/** Creates the diagnostic for a conditional whose condition is not `bool`. */
export const conditionNotBool = <L>(actual: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: conditionNotBoolCode,
  severity: 'error',
  message: `Condition must be bool, found ${actual}`,
  reason: { _tag: 'ConditionNotBool' as const, actual },
  span,
})

export const immutableAssignment = <L>(spelling: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: immutableAssignmentCode,
  severity: 'error',
  message: `Cannot assign through immutable binding ${spelling}`,
  reason: { _tag: 'ImmutableAssignment' as const, spelling },
  span,
})

export const invalidAssignmentPlace = <L>(span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: invalidAssignmentPlaceCode,
  severity: 'error',
  message: 'Assignment requires a writable binding, field, or indexed place',
  reason: { _tag: 'InvalidAssignmentPlace' as const },
  span,
})

export const assignmentTypeMismatch = <L>(
  expected: string,
  actual: string,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: assignmentTypeMismatchCode,
  severity: 'error',
  message: `Assignment expected ${expected} but received ${actual}`,
  reason: { _tag: 'AssignmentTypeMismatch' as const, expected, actual },
  span,
})

/** Creates the diagnostic for an explicit return that violates its declaration result. */
export const returnTypeMismatch = <L>(
  expected: string,
  actual: string,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: returnTypeMismatchCode,
  severity: 'error',
  message: `Return expected ${expected} but received ${actual}`,
  reason: { _tag: 'ReturnTypeMismatch' as const, expected, actual },
  span,
})

/** Creates the diagnostic for a reachable closing brace in a non-unit body. */
export const missingReturn = <L>(expected: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: missingReturnCode,
  severity: 'error',
  message: `A reachable path must return ${expected}`,
  reason: { _tag: 'MissingReturn' as const, expected },
  span,
})

export const transferOutsideLoop = <L>(transfer: 'break' | 'continue', span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: transferOutsideLoopCode,
  severity: 'error',
  message: `${transfer} is only valid inside a loop`,
  reason: { _tag: 'TransferOutsideLoop' as const, transfer },
  span,
})

export const invalidUnionMember = <L>(type: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: invalidUnionMemberCode,
  severity: 'error',
  message: `Structural union members must be detached ordinary values with finite storage, found ${type}`,
  reason: { _tag: 'InvalidUnionMember' as const, type },
  span,
})

export const incompatibleUnionConversion = <L>(
  source: string,
  target: string,
  missing: ReadonlyArray<string>,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: incompatibleUnionConversionCode,
  severity: 'error',
  message: `${source} cannot widen to ${target}; missing ${missing.join(', ')}`,
  reason: {
    _tag: 'IncompatibleUnionConversion' as const,
    source,
    target,
    missing: [...missing],
  },
  span,
})

export const matchScrutineeNotNominal = <L>(actual: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: matchScrutineeNotNominalCode,
  severity: 'error',
  message: `Cannot match non-nominal type ${actual}`,
  reason: { _tag: 'MatchScrutineeNotNominal' as const, actual },
  span,
})

export const matchMemberNotInScrutinee = <L>(
  member: string,
  scrutinee: string,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: matchMemberNotInScrutineeCode,
  severity: 'error',
  message: `${member} is not a member of ${scrutinee}`,
  reason: { _tag: 'MatchMemberNotInScrutinee' as const, member, scrutinee },
  span,
})

export const unreachableMatchArm = <L>(member: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: unreachableMatchArmCode,
  severity: 'error',
  message: `Unreachable match arm ${member}`,
  reason: { _tag: 'UnreachableMatchArm' as const, member },
  span,
})

export const incompleteMatch = <L>(missing: ReadonlyArray<string>, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: incompleteMatchCode,
  severity: 'error',
  message: `Match does not cover ${missing.join(', ')}`,
  reason: {
    _tag: 'IncompleteMatch' as const,
    missing: [...missing],
  },
  span,
})

export const incompleteEnumMatch = <L>(
  enum_: string,
  missing: ReadonlyArray<string>,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: incompleteEnumMatchCode,
  severity: 'error',
  message: `Match over ${enum_} does not cover ${missing.join(', ')}`,
  reason: {
    _tag: 'IncompleteEnumMatch' as const,
    enum: enum_,
    missing: [...missing],
  },
  span,
})

export const duplicateEnumMatchArm = <L>(
  member: string,
  originalSpan: L,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: duplicateEnumMatchArmCode,
  severity: 'error',
  message: `Duplicate enum match arm ${member}`,
  reason: { _tag: 'DuplicateEnumMatchArm' as const, member, originalSpan },
  span,
  relatedSpans: [{ label: 'first covering arm', span: originalSpan }],
})

export const enumMatchArmAfterWildcard = <L>(wildcardSpan: L, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: enumMatchArmAfterWildcardCode,
  severity: 'error',
  message: 'Enum match arm is unreachable after `_`',
  reason: { _tag: 'EnumMatchArmAfterWildcard' as const, wildcardSpan },
  span,
  relatedSpans: [{ label: 'wildcard arm', span: wildcardSpan }],
})

export const foreignEnumPattern = <L>(
  expected: string,
  actual: string,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: foreignEnumPatternCode,
  severity: 'error',
  message: `Enum pattern from ${actual} cannot match ${expected}`,
  reason: { _tag: 'ForeignEnumPattern' as const, expected, actual },
  span,
})

export const integerPatternAgainstEnum = <L>(
  enum_: string,
  value: bigint,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: integerPatternAgainstEnumCode,
  severity: 'error',
  message: `Integer pattern ${value} cannot match enum ${enum_}`,
  reason: {
    _tag: 'IntegerPatternAgainstEnum' as const,
    enum: enum_,
    value: value.toString(),
  },
  span,
})

export const refutableLetPattern = <L>(
  actual: string,
  missing: ReadonlyArray<string>,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: refutableLetPatternCode,
  severity: 'error',
  message: `Let pattern is refutable for ${actual}; it does not cover ${missing.join(', ')}. Use if let or match`,
  reason: {
    _tag: 'RefutableLetPattern' as const,
    actual,
    missing: [...missing],
  },
  span,
})

export const matchGuardNotBool = <L>(actual: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: matchGuardNotBoolCode,
  severity: 'error',
  message: `Match guard must be bool, found ${actual}`,
  reason: { _tag: 'MatchGuardNotBool' as const, actual },
  span,
})

export const missingPatternField = <L>(type: string, field: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: missingPatternFieldCode,
  severity: 'error',
  message: `Pattern for ${type} is missing field ${field}; add it or use ..`,
  reason: { _tag: 'MissingPatternField' as const, type, field },
  span,
})

export const inaccessiblePatternFields = <L>(type: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: missingPatternFieldCode,
  severity: 'error',
  message: `Pattern for ${type} must use .. to omit inaccessible fields`,
  reason: { _tag: 'MissingPatternField' as const, type, field: '<inaccessible>' },
  span,
})

export const duplicatePatternField = <L>(
  field: string,
  originalSpan: L,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: duplicatePatternFieldCode,
  severity: 'error',
  message: `Pattern field ${field} appears more than once`,
  reason: { _tag: 'DuplicatePatternField' as const, field, originalSpan },
  span,
  relatedSpans: [{ label: 'first matched here', span: originalSpan }],
})

export const patternBindingConflict = <L>(
  spelling: string,
  originalSpan: L,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: patternBindingConflictCode,
  severity: 'error',
  message: `Pattern binding ${spelling} conflicts with an existing declaration`,
  reason: { _tag: 'PatternBindingConflict' as const, spelling, originalSpan },
  span,
  relatedSpans: [{ label: 'first declared here', span: originalSpan }],
})

export const incompatibleMatchResults = <L>(
  types: ReadonlyArray<string>,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: incompatibleMatchResultsCode,
  severity: 'error',
  message: `Match arms have incompatible result types: ${types.join(', ')}`,
  reason: {
    _tag: 'IncompatibleMatchResults' as const,
    types: [...types],
  },
  span,
})

/** Creates the diagnostic for an effect-block return whose type disagrees with the block's. */
export const effectBlockReturnMismatch = <L>(
  types: ReadonlyArray<string>,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: effectBlockReturnMismatchCode,
  severity: 'error',
  message: `Effect block return sites have incompatible types: ${types.join(', ')}`,
  reason: {
    _tag: 'EffectBlockReturnMismatch' as const,
    types: [...types],
  },
  span,
})

export const divergentRepresentationJoin = <L>(
  expected: string,
  actual: string,
  originSpans: readonly [L, L],
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: divergentRepresentationJoinCode,
  severity: 'error',
  message: `Cannot join ${expected} with ${actual}; consume each represented value inside its branch before joining`,
  reason: {
    _tag: 'DivergentRepresentationJoin' as const,
    expected,
    actual,
    originSpans: originSpans,
  },
  span,
  relatedSpans: [
    { label: 'first representation originates here', span: originSpans[0] },
    { label: 'divergent representation originates here', span: originSpans[1] },
  ],
})

export const duplicateTypeParameter = <L>(
  spelling: string,
  originalSpan: L,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: duplicateTypeParameterCode,
  severity: 'error',
  message: `Duplicate type parameter ${spelling}`,
  reason: { _tag: 'DuplicateTypeParameter' as const, spelling, originalSpan },
  span,
  relatedSpans: [{ label: 'first declared here', span: originalSpan }],
})

export const genericParameterKindMismatch = <L>(
  spelling: string,
  expected:
    | 'Lifetime'
    | 'Value'
    | 'RequirementRow'
    | 'CallableRepresentation'
    | 'EffectRepresentation',
  actual:
    | 'Lifetime'
    | 'Value'
    | 'RequirementRow'
    | 'CallableRepresentation'
    | 'EffectRepresentation',
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: genericParameterKindMismatchCode,
  severity: 'error',
  message: `Generic parameter ${spelling} has kind ${actual}, expected ${expected}`,
  reason: {
    _tag: 'GenericParameterKindMismatch' as const,
    spelling,
    expected,
    actual,
  },
  span,
})

export const incompatibleRepresentationBound = <L>(
  parameter: string,
  required: string,
  actual: string,
  span: L,
  provenance: {
    readonly requiredDeclarationSpan?: L
    readonly actualDeclarationSpan?: L
  } = {},
): Diagnostic<L> => {
  const relatedSpans: Array<RelatedSpan<L>> = []
  if (provenance.requiredDeclarationSpan !== undefined)
    relatedSpans.push({
      label: 'required representation bound declared here',
      span: provenance.requiredDeclarationSpan,
    })
  if (provenance.actualDeclarationSpan !== undefined)
    relatedSpans.push({
      label: 'supplied representation bound declared here',
      span: provenance.actualDeclarationSpan,
    })
  return {
    _tag: 'Diagnostic',
    phase: 'semantic',
    code: incompatibleRepresentationBoundCode,
    severity: 'error',
    message: `Representation ${parameter} requires ${required}, but the supplied bound ${actual} is not admissible`,
    reason: {
      _tag: 'IncompatibleRepresentationBound' as const,
      parameter,
      required,
      actual,
      ...(provenance.requiredDeclarationSpan === undefined
        ? {}
        : { requiredDeclarationSpan: provenance.requiredDeclarationSpan }),
      ...(provenance.actualDeclarationSpan === undefined
        ? {}
        : { actualDeclarationSpan: provenance.actualDeclarationSpan }),
    },
    span,
    ...(relatedSpans.length === 0 ? {} : { relatedSpans: relatedSpans }),
  }
}

type ContractRowInferenceProblem = Extract<
  Reason,
  { readonly _tag: 'ContractRowInference' }
>['problem']

const contractRowInferenceMessage = (problem: ContractRowInferenceProblem): string => {
  switch (problem._tag) {
    case 'AbsentFailureMember':
      return `Failure type does not contain selected member ${problem.member}`
    case 'AbsentRequirementMember':
      // Two complete templates rather than one with the access marker interpolated, so the
      // generated diagnostic catalog pins both wordings this problem can report.
      return problem.access === 'Exclusive'
        ? `Requirement row does not contain &mut ${problem.capability}@${problem.role}`
        : `Requirement row does not contain &${problem.capability}@${problem.role}`
    case 'IncompatibleRequirementRole':
      return `Requirement ${problem.capability} has role ${problem.actual.join(' or ')}, expected ${problem.expected}`
    case 'IncompatibleRequirementAccess':
      return `Requirement ${problem.capability}@${problem.role} has access ${problem.actual.join(' or ')}, expected ${problem.expected}`
    case 'AmbiguousRequirementRemainder':
      return `Requirement row remainder is ambiguous across ${problem.parameters.join(', ')}`
    case 'NonFiniteRequirementRow':
      return 'Requirement row specialization is not finite and concrete'
  }
}

/** Preserves the first failed inference obligation instead of attributing every open row to it. */
export const inferenceFailure = <L>(
  problem:
    | ContractRowInferenceProblem
    | {
        readonly _tag: 'EnvironmentMismatch'
        readonly longer: string
        readonly shorter: string
      },
  span: L,
): Diagnostic<L> =>
  problem._tag === 'EnvironmentMismatch'
    ? unsatisfiedLifetimeBound(problem.longer, problem.shorter, span)
    : contractRowInference(problem, span)

export const contractRowInference = <L>(
  problem: ContractRowInferenceProblem,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: contractRowInferenceCode,
  severity: 'error',
  message: contractRowInferenceMessage(problem),
  reason: {
    _tag: 'ContractRowInference' as const,
    problem: problem,
  },
  span,
})

export const typeArgumentArity = <L>(
  target: string,
  expected: number,
  actual: number,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: typeArgumentArityCode,
  severity: 'error',
  message: `${target} expects ${expected} type argument${expected === 1 ? '' : 's'}, received ${actual}`,
  reason: { _tag: 'TypeArgumentArity' as const, target, expected, actual },
  span,
})

export const typeArgumentInference = <L>(target: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: typeArgumentInferenceCode,
  severity: 'error',
  message: `Cannot infer all type arguments for ${target} from supplied values`,
  reason: { _tag: 'TypeArgumentInference' as const, target },
  span,
})

export const uninferredTypeParameter = <L>(
  target: string,
  parameter: string,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: uninferredTypeParameterCode,
  severity: 'error',
  message: `Cannot infer type argument ${parameter} of ${target} from supplied values`,
  reason: { _tag: 'UninferredTypeParameter' as const, target, parameter },
  span,
})

export const typeArgumentConflict = <L>(
  target: string,
  parameter: string,
  written: string,
  implied: string,
  span: L,
  firstConstraint?: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: typeArgumentConflictCode,
  severity: 'error',
  message: `Type argument ${parameter} of ${target} is ${written}, but the supplied values imply ${implied}`,
  reason: {
    _tag: 'TypeArgumentConflict' as const,
    target,
    parameter,
    written,
    implied,
  },
  span,
  ...(firstConstraint === undefined
    ? {}
    : {
        relatedSpans: [{ label: 'type argument first constrained here', span: firstConstraint }],
      }),
})

export const polymorphicRecursion = <L>(
  caller: string,
  target: string,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: polymorphicRecursionCode,
  severity: 'error',
  message: `Recursive specialization changes type arguments from ${caller} to ${target}`,
  reason: { _tag: 'PolymorphicRecursion' as const, caller, target },
  span,
})

/** Diagnoses a reachable sealed operation before its unsupported execution surface is entered. */
export const intrinsicTargetUnavailable = <L>(
  operation: string,
  target: Target.Id,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: intrinsicTargetUnavailableCode,
  severity: 'error',
  message: `${operation} is unavailable for ${target}`,
  reason: { _tag: 'IntrinsicTargetUnavailable' as const, operation, target },
  span,
})

/** Diagnoses a known mismatch before MIR consumes either affine initializer argument. */
export const localSharedLayoutMismatch = <L>(
  expected: string,
  actual: string,
  allocationSpan: L,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: localSharedLayoutMismatchCode,
  severity: 'error',
  message: `Local-shared allocation was planned for ${actual}, not ${expected}`,
  reason: { _tag: 'LocalSharedLayoutMismatch' as const, expected, actual },
  span,
  relatedSpans: [
    {
      label: 'allocation layout provenance originates here',
      span: allocationSpan,
    },
  ],
})

/** Diagnoses a mismatched execution-package allocation before initializer publication. */
export const executionLayoutMismatch = <L>(
  expected: string,
  actual: string,
  allocationSpan: L,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: executionLayoutMismatchCode,
  severity: 'error',
  message: `Execution allocation was planned for ${actual}, not ${expected}`,
  reason: { _tag: 'ExecutionLayoutMismatch' as const, expected, actual },
  span,
  relatedSpans: [
    {
      label: 'allocation layout provenance originates here',
      span: allocationSpan,
    },
  ],
})

/** Diagnoses one failed sealed-property check at its concrete application obligation. */
export const unsatisfiedExecutableProperty = <L>(
  property: 'Intrinsic.Detached' | 'Intrinsic.NonParking',
  causes: ReadonlyArray<string>,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: unsatisfiedExecutablePropertyCode,
  severity: 'error',
  message: `${property} is unsatisfied: ${causes.join('; ')}`,
  reason: {
    _tag: 'UnsatisfiedExecutableProperty' as const,
    property,
    causes: Array.from(causes),
  },
  span,
})

/** Rejects ordinary interface/service bounds in the sealed exact-executable conjunction lane. */
export const invalidExecutablePropertyConjunct = <L>(conjunct: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: invalidExecutablePropertyConjunctCode,
  severity: 'error',
  message: `${conjunct} is not a sealed executable property`,
  reason: { _tag: 'InvalidExecutablePropertyConjunct' as const, conjunct },
  span,
})

export const missingUnsafeBoundary = <L>(operation: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: missingUnsafeBoundaryCode,
  severity: 'error',
  message: `${operation} requires unsafe acknowledgement`,
  reason: { _tag: 'MissingUnsafeBoundary' as const, operation },
  span,
})

export const misplacedUnsafeAcknowledgement = <L>(span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: misplacedUnsafeAcknowledgementCode,
  severity: 'error',
  message: '`unsafe` must acknowledge a complete unsafe invocation',
  reason: { _tag: 'MisplacedUnsafeAcknowledgement' as const },
  span,
})

/** Rejects nested anonymous bodies until transitive capture lifting has a language contract. */
export const nestedAnonymousCallable = <L>(span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: nestedAnonymousCallableCode,
  severity: 'error',
  message: 'Anonymous callable bodies cannot be nested in this language slice',
  reason: { _tag: 'NestedAnonymousCallable' as const },
  span,
})

export const invalidConformance = <L>(detail: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: invalidConformanceCode,
  severity: 'error',
  message: `Invalid conformance: ${detail}`,
  reason: { _tag: 'InvalidConformance' as const, detail },
  span,
})

/**
 * Creates the diagnostic for two conformance heads that may name one provider under one interface.
 *
 * Overlap is decided on shapes alone, so this fires even when the two declarations' requirements
 * look mutually exclusive: whether a requirement is satisfiable depends on the whole program and
 * changes as declarations are added, and a coherence answer that moved with the program would let
 * one specialization silently change which witness it selects.
 */
export const overlappingConformance = <L>(
  head: string,
  other: string,
  span: L,
  originalSpan?: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: overlappingConformanceCode,
  severity: 'error',
  message: `${head} may overlap ${other}`,
  reason: { _tag: 'OverlappingConformance' as const, head, other },
  span,
  ...(originalSpan === undefined
    ? {}
    : {
        relatedSpans: [{ label: 'overlapping implementation', span: originalSpan }],
      }),
  notes: [
    'Conformance overlap is decided without consulting bounds, because whether a bound is satisfiable changes as a program grows.',
  ],
})

/**
 * Creates the diagnostic for a conformance requirement that does not descend toward a base witness.
 *
 * Each listed failure names one condition the header broke. Together the three conditions make the
 * provider term a well-founded measure, which is why proof search needs no fuel: a requirement that
 * satisfies them can only be followed finitely many times.
 */
export const nonTerminatingConformance = <L>(
  head: string,
  failures: ReadonlyArray<string>,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: nonTerminatingConformanceCode,
  severity: 'error',
  message: `${head} declares a requirement that does not descend`,
  reason: {
    _tag: 'NonTerminatingConformance' as const,
    head,
    failures: [...failures],
  },
  span,
  notes: [...failures],
})

/**
 * Creates the diagnostic for a specialization whose conditional requirements cannot be proved.
 *
 * The trace is the useful half: a missing base witness reported alone says only that some type
 * lacks a conformance, while the chain says which wrapper asked for it and through which
 * requirement, which is what tells the author where to declare the missing implementation.
 */
export const unprovenConformance = <L>(
  goal: string,
  detail: string,
  trace: ReadonlyArray<string>,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: unprovenConformanceCode,
  severity: 'error',
  message: `${goal} cannot be proved: ${detail}`,
  reason: {
    _tag: 'UnprovenConformance' as const,
    goal,
    detail,
    trace: [...trace],
  },
  span,
  ...(trace.length === 0 ? {} : { notes: [...trace] }),
})

export const nonConcreteSpecialization = <L>(declaration: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: nonConcreteSpecializationCode,
  severity: 'error',
  message: `${declaration} reaches a complete application with unresolved contract rows or evidence`,
  reason: { _tag: 'NonConcreteSpecialization' as const, declaration },
  span,
})

const providerSelectionFields = <L>(
  problem: ProviderSelection.SelectionProblem,
  locations: ProviderSelection.DiagnosticLocations<L>,
  originKey: ProviderSelection.OriginKey<L>,
) => {
  const primarySpan = locations.primary
  const primaryKey = originKey(primarySpan)
  const related = locations.relations
    .flatMap((relation) => relation.origins)
    .filter((origin) => originKey(origin) !== primaryKey)
    .map((span) => ({ label: 'contributing provider constraint', span }))
  return {
    reason: { _tag: 'ProviderSelection' as const, problem },
    span: primarySpan,
    ...(related.length === 0 ? {} : { relatedSpans: related }),
  }
}

const providerNoMatch = <L>(
  problem: Extract<ProviderSelection.SelectionProblem, { readonly _tag: 'ProviderNoMatch' }>,
  locations: ProviderSelection.DiagnosticLocations<L>,
  originKey: ProviderSelection.OriginKey<L>,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: providerNoMatchCode,
  severity: 'error',
  message: 'The provider matches no compatible requirement',
  ...providerSelectionFields(problem, locations, originKey),
})

const providerAccessMismatch = <L>(
  problem: Extract<ProviderSelection.SelectionProblem, { readonly _tag: 'ProviderAccessMismatch' }>,
  locations: ProviderSelection.DiagnosticLocations<L>,
  originKey: ProviderSelection.OriginKey<L>,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: providerAccessMismatchCode,
  severity: 'error',
  message: `${problem.provider.toLowerCase()} provider access cannot satisfy an ${problem.required.toLowerCase()} requirement`,
  ...providerSelectionFields(problem, locations, originKey),
})

const jointProviderSelectionConflict = <L>(
  problem: Extract<ProviderSelection.SelectionProblem, { readonly _tag: 'JointSelectionConflict' }>,
  locations: ProviderSelection.DiagnosticLocations<L>,
  originKey: ProviderSelection.OriginKey<L>,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: jointProviderSelectionConflictCode,
  severity: 'error',
  message: 'Provider constraints select incompatible requirement members',
  ...providerSelectionFields(problem, locations, originKey),
})

const providerAmbiguity = <L>(
  problem: Extract<ProviderSelection.SelectionProblem, { readonly _tag: 'ProviderAmbiguity' }>,
  locations: ProviderSelection.DiagnosticLocations<L>,
  originKey: ProviderSelection.OriginKey<L>,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: providerAmbiguityCode,
  severity: 'error',
  message: 'The provider matches more than one requirement; select one explicitly',
  ...providerSelectionFields(problem, locations, originKey),
})

const selectedRowCardinality = <L>(
  problem: Extract<ProviderSelection.SelectionProblem, { readonly _tag: 'SelectedRowCardinality' }>,
  locations: ProviderSelection.DiagnosticLocations<L>,
  originKey: ProviderSelection.OriginKey<L>,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: selectedRowCardinalityCode,
  severity: 'error',
  message: `Selected requirement row has ${problem.count} members; exactly one is required`,
  ...providerSelectionFields(problem, locations, originKey),
})

const providerConformanceAmbiguity = <L>(
  problem: Extract<ProviderSelection.SelectionProblem, { readonly _tag: 'ConformanceAmbiguity' }>,
  locations: ProviderSelection.DiagnosticLocations<L>,
  originKey: ProviderSelection.OriginKey<L>,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: providerConformanceAmbiguityCode,
  severity: 'error',
  message: 'More than one conformance witness can provide the selected requirement',
  ...providerSelectionFields(problem, locations, originKey),
})

const invalidProviderConformance = <L>(
  problem: Extract<ProviderSelection.SelectionProblem, { readonly _tag: 'InvalidConformance' }>,
  locations: ProviderSelection.DiagnosticLocations<L>,
  originKey: ProviderSelection.OriginKey<L>,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: invalidProviderConformanceCode,
  severity: 'error',
  message: `The provider's conformance mapping is invalid: ${problem.reason}`,
  ...providerSelectionFields(problem, locations, originKey),
})

/** Preserves the solver's span-free semantic payload separately from ordered source locations. */
export const providerSelection = <L>(
  diagnostic: ProviderSelection.SelectionDiagnostic<L>,
  originKey: ProviderSelection.OriginKey<L>,
): Diagnostic<L> => {
  const problem = diagnostic.problem
  switch (problem._tag) {
    case 'ProviderNoMatch':
      return providerNoMatch(problem, diagnostic.locations, originKey)
    case 'ProviderAccessMismatch':
      return providerAccessMismatch(problem, diagnostic.locations, originKey)
    case 'JointSelectionConflict':
      return jointProviderSelectionConflict(problem, diagnostic.locations, originKey)
    case 'ProviderAmbiguity':
      return providerAmbiguity(problem, diagnostic.locations, originKey)
    case 'SelectedRowCardinality':
      return selectedRowCardinality(problem, diagnostic.locations, originKey)
    case 'ConformanceAmbiguity':
      return providerConformanceAmbiguity(problem, diagnostic.locations, originKey)
    case 'InvalidConformance':
      return invalidProviderConformance(problem, diagnostic.locations, originKey)
  }
}

/**
 * Creates the diagnostic for a bound operation reachable through more than one bounded parameter.
 *
 * The receiver of a bound operation call is the bound's own name, so one declaration bounding two
 * of its parameters by the same interface leaves the call naming no single parameter. The operation
 * is real and the bound is satisfied; what is missing is which parameter's witness answers it.
 */
export const ambiguousBoundOperation = <L>(
  spelling: string,
  parameters: ReadonlyArray<string>,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: ambiguousBoundOperationCode,
  severity: 'error',
  message: `${spelling} is ambiguous across bounded type parameters ${parameters.join(', ')}`,
  reason: {
    _tag: 'AmbiguousBoundOperation' as const,
    spelling,
    parameters: [...parameters],
  },
  span,
})

/**
 * Creates the diagnostic for a bound operation whose specialization selects a witness that has no
 * lowering.
 *
 * A witness answers with a sealed intrinsic or with a function of the provider's own actor, and a
 * bound operation call reaches both. A conformance that names neither leaves the call with nothing
 * to run: it would lower to nothing, and the specialized instance would fail MIR validation with no
 * user-visible cause. A call that passes analysis and produces no code is a reported error, because
 * the alternative is a silent miscompile.
 */
export const unlowerableBoundWitness = <L>(
  spelling: string,
  provider: string,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: unlowerableBoundWitnessCode,
  severity: 'error',
  message: `${spelling} has no witness that can be lowered for ${provider}`,
  reason: { _tag: 'UnlowerableBoundWitness' as const, spelling, provider },
  span,
})

export const invalidServiceDeclaration = <L>(detail: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: invalidServiceDeclarationCode,
  severity: 'error',
  message: `Invalid service declaration: ${detail}`,
  reason: { _tag: 'InvalidServiceDeclaration' as const, detail },
  span,
})

export const invalidTestDeclaration = <L>(detail: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: invalidTestDeclarationCode,
  severity: 'error',
  message: `Invalid test declaration: ${detail}`,
  reason: { _tag: 'InvalidTestDeclaration' as const, detail },
  span,
})

/** Reports a function instance emitted code references whose valid body native lowering lacks. */
export const unsupportedLowering = <L>(span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: unsupportedLoweringCode,
  severity: 'error',
  message: 'Native lowering does not support this function body yet',
  reason: { _tag: 'UnsupportedLowering' as const },
  span,
})

export const invalidMutableParameter = <L>(
  context: 'BorrowedView' | 'Contract',
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: invalidMutableParameterCode,
  severity: 'error',
  message:
    context === 'Contract'
      ? '`mut` declares function-local owned parameter storage and is not valid in a service or interface contract'
      : '`mut` declares mutable owned parameter storage; use `&mut` for exclusive borrowed access',
  reason: { _tag: 'InvalidMutableParameter' as const, context },
  span,
})

/** Rejects mutation whose execution time cannot preserve the outer callable's exact recipe. */
export const deferredCallableMutation = <L>(spelling: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: deferredCallableMutationCode,
  severity: 'error',
  message: `A deferred effect cannot mutate captured callable binding ${spelling}`,
  reason: { _tag: 'DeferredCallableMutation' as const, spelling },
  span,
})

export const invalidDropHook = <L>(detail: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: invalidDropHookCode,
  severity: 'error',
  message: `Invalid Drop hook: ${detail}`,
  reason: { _tag: 'InvalidDropHook' as const, detail },
  span,
})

export const invalidBorrowOperand = <L>(span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: invalidBorrowOperandCode,
  severity: 'error',
  message: 'A borrowed view requires a direct stable owner or borrowed view',
  reason: { _tag: 'InvalidBorrowOperand' as const },
  span,
})

export const exclusiveBorrowRequiresMutable = <L>(spelling: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: exclusiveBorrowRequiresMutableCode,
  severity: 'error',
  message: `Exclusive borrowing requires mutable binding ${spelling}`,
  reason: { _tag: 'ExclusiveBorrowRequiresMutable' as const, spelling },
  span,
})

export const invalidSliceReborrow = <L>(
  parent: 'Shared' | 'Exclusive',
  requested: 'Shared' | 'Exclusive',
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: invalidSliceReborrowCode,
  severity: 'error',
  message: 'A shared slice cannot be reborrowed exclusively',
  reason: { _tag: 'InvalidSliceReborrow' as const, parent, requested },
  span,
})

export const implicitSliceDecay = <L>(expected: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: implicitSliceDecayCode,
  severity: 'error',
  message: `Passing an array as ${expected} requires an explicit borrow`,
  reason: { _tag: 'ImplicitSliceDecay' as const, expected },
  span,
})

/** Creates the diagnostic for a call argument whose type mismatches its parameter. */
export const argumentTypeMismatch = <L>(
  expected: string,
  actual: string,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: argumentTypeMismatchCode,
  severity: 'error',
  message: `Expected ${expected} but received ${actual}`,
  reason: { _tag: 'ArgumentTypeMismatch' as const, expected, actual },
  span,
})

export const nonCallableApplication = <L>(actual: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: nonCallableApplicationCode,
  severity: 'error',
  message: `Cannot call non-callable value ${actual}`,
  reason: { _tag: 'NonCallableApplication' as const, actual },
  span,
})

export const incompatibleCallableSignature = <L>(
  expected: string,
  actual: string,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: incompatibleCallableSignatureCode,
  severity: 'error',
  message: `Callable ${actual} cannot satisfy ${expected}`,
  reason: { _tag: 'IncompatibleCallableSignature' as const, expected, actual },
  span,
})

export const invalidCallableInvocationAccess = <L>(
  required: 'Shared' | 'Exclusive' | 'Take',
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: invalidCallableInvocationAccessCode,
  severity: 'error',
  message: `Callable invocation requires ${required.toLowerCase()} access`,
  reason: { _tag: 'InvalidCallableInvocationAccess' as const, required },
  span,
})

export const redundantUnaryEmptyCall = <L>(target: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: redundantUnaryEmptyCallCode,
  severity: 'error',
  message: `${target} is unary; name it directly instead of calling it with no arguments`,
  reason: { _tag: 'RedundantUnaryEmptyCall' as const, target },
  span,
})

/** Creates the diagnostic for a binding used again after its consuming move. */
export const useAfterMove = <L>(spelling: string, moveSpan: L, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'ownership',
  code: useAfterMoveCode,
  severity: 'error',
  message: `${spelling} was moved and cannot be used again`,
  reason: { _tag: 'UseAfterMove' as const, spelling, moveSpan },
  span,
  relatedSpans: [{ label: 'moved here', span: moveSpan }],
})

export const partialMove = <L>(span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'ownership',
  code: partialMoveCode,
  severity: 'error',
  message: 'This place crosses a boundary that does not support partial moves',
  reason: { _tag: 'PartialMove' as const },
  span,
})

/**
 * A stored callable is reached through its enclosing aggregate, so the aggregate's own access bounds
 * the modes its environment admits: a shared receiver invokes only `fn`, an exclusive receiver also
 * invokes `mut fn`, and only a whole-owner receiver may consume a `once fn`.
 */
export const storedCallableInvocationAccess = <L>(
  aggregate: string,
  field: string,
  contract: string,
  receiver: 'Shared' | 'Exclusive' | 'Take',
  required: 'Shared' | 'Exclusive' | 'Take',
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'ownership',
  code: storedCallableInvocationAccessCode,
  severity: 'error',
  message: `Cannot invoke field ${field} of ${aggregate} through ${receiver.toLowerCase()} aggregate access: ${contract} requires ${required.toLowerCase()} access to the whole aggregate`,
  reason: {
    _tag: 'StoredCallableInvocationAccess' as const,
    aggregate,
    field,
    contract,
    receiver,
    required,
  },
  span,
})

/**
 * A stored Effect is reached through its enclosing aggregate, so the aggregate's own access bounds
 * its run mode: a shared receiver runs only `Effect`, an exclusive receiver also runs `mut Effect`,
 * and only a whole-owner receiver may consume a `once Effect`.
 */
export const storedEffectRunAccess = <L>(
  aggregate: string,
  field: string,
  contract: string,
  receiver: 'Shared' | 'Exclusive' | 'Take',
  required: 'Shared' | 'Exclusive' | 'Take',
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'ownership',
  code: storedEffectRunAccessCode,
  severity: 'error',
  message: `Cannot run field ${field} of ${aggregate} through ${receiver.toLowerCase()} aggregate access: ${contract} requires ${required.toLowerCase()} access to the whole aggregate`,
  reason: {
    _tag: 'StoredEffectRunAccess' as const,
    aggregate,
    field,
    contract,
    receiver,
    required,
  },
  span,
})

export const explicitMoveRequired = <L>(spelling: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'ownership',
  code: explicitMoveRequiredCode,
  severity: 'error',
  message: `Moving ${spelling} requires an explicit move`,
  reason: { _tag: 'ExplicitMoveRequired' as const, spelling },
  span,
})

export const overlappingAssignment = <L>(spelling: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'ownership',
  code: overlappingAssignmentCode,
  severity: 'error',
  message: `Assignment to ${spelling} consumes the same owner before replacement commits`,
  reason: { _tag: 'OverlappingAssignment' as const, spelling },
  span,
})

export const incompatibleLoopHeader = <L>(loop: number, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'ownership',
  code: incompatibleLoopHeaderCode,
  severity: 'error',
  message: `Loop ${loop} repeats with incompatible owner liveness`,
  reason: { _tag: 'IncompatibleLoopHeader' as const, loop },
  span,
})

export const incompatibleArmMerge = <L>(spelling: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'ownership',
  code: incompatibleArmMergeCode,
  severity: 'error',
  message: `Branches merge with incompatible owner liveness for ${spelling}`,
  reason: { _tag: 'IncompatibleArmMerge' as const, spelling },
  span,
})

export const matchBorrowEscape = <L>(spelling: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'ownership',
  code: matchBorrowEscapeCode,
  severity: 'error',
  message: `Borrowed pattern binding ${spelling} cannot escape its match arm`,
  reason: { _tag: 'MatchBorrowEscape' as const, spelling },
  span,
})

/** Rejects a callable environment whose borrowed root ends when its creating function returns. */
export const executableBorrowEscape = <L>(
  executable: 'Callable' | 'Effect',
  spelling: string,
  access: 'Shared' | 'Exclusive',
  span: L,
  returnSpan: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'ownership',
  code: executableBorrowEscapeCode,
  severity: 'error',
  message: `${executable} cannot escape with a ${access.toLowerCase()} borrow of local ${spelling}`,
  reason: {
    _tag: 'ExecutableBorrowEscape' as const,
    executable,
    spelling,
    access,
  },
  span,
  relatedSpans: [{ label: `${executable.toLowerCase()} escapes here`, span: returnSpan }],
})

export const exclusiveMatchRequiresMutable = <L>(spelling: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'ownership',
  code: exclusiveMatchRequiresMutableCode,
  severity: 'error',
  message: `Exclusive match requires mutable binding ${spelling}`,
  reason: { _tag: 'ExclusiveMatchRequiresMutable' as const, spelling },
  span,
})

export const guardConsumesPattern = <L>(spelling: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'ownership',
  code: guardConsumesPatternCode,
  severity: 'error',
  message: `Match guard cannot consume pattern binding ${spelling}`,
  reason: { _tag: 'GuardConsumesPattern' as const, spelling },
  span,
})

export const invalidMatchScrutineePlace = <L>(
  access: 'Move' | 'Exclusive' | 'Place',
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'ownership',
  code: invalidMatchScrutineePlaceCode,
  severity: 'error',
  message: `${access} match requires a complete binding place`,
  reason: { _tag: 'InvalidMatchScrutineePlace' as const, access },
  span,
})

export const conflictingViewLoan = <L>(
  existing: 'Shared' | 'Exclusive',
  requested: 'Shared' | 'Exclusive',
  loanSpan: L,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'ownership',
  code: conflictingViewLoanCode,
  severity: 'error',
  message: `${requested} borrowed-view loan conflicts with an active ${existing.toLowerCase()} loan`,
  reason: { _tag: 'ConflictingViewLoan' as const, existing, requested, loanSpan },
  span,
  relatedSpans: [{ label: 'active loan begins here', span: loanSpan }],
})

export const ownerAccessDuringLoan = <L>(
  spelling: string,
  access: 'Read' | 'Write' | 'Move',
  loanSpan: L,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'ownership',
  code: ownerAccessDuringLoanCode,
  severity: 'error',
  message: `${access.toLowerCase()} access to ${spelling} conflicts with an active borrowed-view loan`,
  reason: { _tag: 'OwnerAccessDuringLoan' as const, spelling, access, loanSpan },
  span,
  relatedSpans: [{ label: 'active loan begins here', span: loanSpan }],
})

export const borrowedMove = <L>(span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'ownership',
  code: borrowedMoveCode,
  severity: 'error',
  message: 'A non-Copy value cannot be moved out through a borrowed-view place',
  reason: { _tag: 'BorrowedMove' as const },
  span,
})

const localSharedAccessEscapeMessage = (kind: 'Callback' | 'Result' | 'Suspension'): string => {
  if (kind === 'Suspension') {
    return 'Local-shared access cannot suspend while its exclusive borrow is live'
  }
  if (kind === 'Callback') {
    return 'Local-shared access cannot invoke an external readiness callback while its exclusive borrow is live'
  }
  return 'Local-shared access callback cannot return a value that retains its exclusive borrow'
}

/** Relates one access-scoped escape to the sealed boundary that created the exclusive loan. */
export const localSharedAccessEscape = <L>(
  kind: 'Callback' | 'Result' | 'Suspension',
  span: L,
  boundary: L,
): Diagnostic<L> => {
  return {
    _tag: 'Diagnostic',
    phase: 'ownership',
    code: localSharedAccessEscapeCode,
    severity: 'error',
    message: localSharedAccessEscapeMessage(kind),
    reason: { _tag: 'LocalSharedAccessEscape' as const, kind },
    span,
    relatedSpans: [{ label: 'local-shared access boundary', span: boundary }],
  }
}

/** Creates the diagnostic for a uniquely resolved call with the wrong arity. */
export const wrongCallArity = <L>(
  target: DeclarationEntity | BuiltinEntity,
  expectedCount: number,
  actualCount: number,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: wrongCallArityCode,
  severity: 'error',
  message: `Expected ${expectedCount} ${expectedCount === 1 ? 'argument' : 'arguments'} but received ${actualCount}`,
  reason: {
    _tag: 'WrongCallArity' as const,
    target,
    expectedCount,
    actualCount,
  },
  span,
  ...(target._tag === 'DeclarationId' ? { entity: target } : {}),
})

/** Rejects an exported C function whose MIR body may suspend, relating the suspending call. */
export const exportSuspends = <L>(symbol: string, span: L, callSpan?: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: exportSuspendsCode,
  severity: 'error',
  message: `Exported function ${symbol} may suspend; a C-callable body must be synchronous`,
  reason: { _tag: 'ExportSuspends' as const, symbol },
  span,
  ...(callSpan === undefined
    ? {}
    : {
        relatedSpans: [{ label: 'suspending call', span: callSpan }],
      }),
})

/** Reports an explicit region outside its declaration or callable binder scope. */
export const unknownLifetime = <L>(spelling: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: unknownLifetimeCode,
  severity: 'error',
  message: `Unknown lifetime ${spelling}`,
  reason: { _tag: 'UnknownLifetime' as const, spelling },
  span,
})

/** Requests a written relationship when an output has no unique borrowed input. */
export const ambiguousLifetimeElision = <L>(span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: ambiguousLifetimeElisionCode,
  severity: 'error',
  message: 'The omitted output lifetime has no unique input; name its lifetime explicitly',
  reason: { _tag: 'AmbiguousLifetimeElision' as const },
  span,
})

/** Reports unsupported lifetime binder syntax without inventing a semantic relationship. */
export const invalidLifetimeBinder = <L>(detail: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: invalidLifetimeBinderCode,
  severity: 'error',
  message: `Invalid lifetime binder: ${detail}`,
  reason: { _tag: 'InvalidLifetimeBinder' as const, detail },
  span,
})

/** Rejects a selected lifetime relationship that the caller cannot prove. */
export const unsatisfiedLifetimeBound = <L>(
  longer: string,
  shorter: string,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: unsatisfiedLifetimeBoundCode,
  severity: 'error',
  message: `Lifetime ${longer} does not outlive ${shorter}`,
  reason: { _tag: 'UnsatisfiedLifetimeBound' as const, longer, shorter },
  span,
})

/** Rejects a selected generic value whose retained data cannot satisfy its lifetime bound. */
export const unsatisfiedTypeOutlives = <L>(
  type: string,
  lifetime: string,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: unsatisfiedTypeOutlivesCode,
  severity: 'error',
  message: `Type ${type} does not remain valid for ${lifetime}`,
  reason: { _tag: 'UnsatisfiedTypeOutlives' as const, type, lifetime },
  span,
})

/** Locates a value use outside the finite validity of its borrowed storage. */
export const expiredLifetime = <L>(lifetime: string, span: L, origin?: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'ownership',
  code: expiredLifetimeCode,
  severity: 'error',
  message: `Lifetime ${lifetime} does not remain valid at this use`,
  reason: { _tag: 'ExpiredLifetime' as const, lifetime },
  span,
  ...(origin === undefined
    ? {}
    : {
        relatedSpans: [{ label: 'borrowed storage originates here', span: origin }],
      }),
})

/** Publishes an ownership planner rejection at the source suspension boundary. */
export const invalidSuspensionOwnership = <L>(detail: string, span: L): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'ownership',
  code: invalidSuspensionOwnershipCode,
  severity: 'error',
  message: `Cannot preserve ownership across suspension: ${detail}`,
  reason: { _tag: 'InvalidSuspensionOwnership' as const, detail },
  span,
})

/** Preserves typed configuration origins and dependency failures without interpolating values. */
// Configuration origins are positions in this revision's configuration, so this diagnostic is only
// ever a published one.
export const invalidConfiguration = (
  error: ConfigurationError.ConfigurationError,
  span: SourceSpan.SourceSpan,
): Diagnostic => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: invalidConfigurationCode,
  severity: 'error',
  message: `Invalid compilation configuration: ${error.message}`,
  reason: { _tag: 'InvalidConfiguration' as const, error },
  span,
  relatedSpans: error.origins.flatMap((origin) =>
    origin.span === undefined ? [] : [{ label: origin.source, span: origin.span }],
  ),
})

/**
 * The same rejection for configuration written in a declaration header, located at its node.
 *
 * ponytail: the origins inside `error` still hold this revision's spans. Headers are rebuilt for
 * every revision, so nothing stale is reported; give origins locations when headers are cached.
 */
export const invalidAuthoredConfiguration = <L>(
  error: ConfigurationError.ConfigurationError,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: invalidConfigurationCode,
  severity: 'error',
  message: `Invalid compilation configuration: ${error.message}`,
  reason: { _tag: 'InvalidConfiguration' as const, error },
  span,
  relatedSpans: error.origins.flatMap((origin) =>
    origin.span === undefined ? [] : [{ label: origin.source, span }],
  ),
})

/** Reports an invalid minimum alignment or unsupported raw data address space. */
export const invalidPointerQualifier = <L>(
  qualifier: string,
  detail: string,
  span: L,
): Diagnostic<L> => ({
  _tag: 'Diagnostic',
  phase: 'semantic',
  code: invalidPointerQualifierCode,
  severity: 'error',
  message: `Invalid pointer qualifier ${qualifier}: ${detail}`,
  reason: { _tag: 'InvalidPointerQualifier' as const, qualifier, detail },
  span,
})
