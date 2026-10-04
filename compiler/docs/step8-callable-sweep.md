# Step 8 callable coverage

This receipt belongs to [#567 Step 8](https://github.com/julia-script/silk/issues/567).
This is an intermediate coverage receipt; Step 8 remains unchecked while the in-scope
higher-order return-origin work below is unfinished. Exact CI receipts and merged heads belong
on that issue; source assertions and corpus pins remain in the repository. Native borrow obligations remain explicitly NotChecked
until Step 14.

## Corpus evidence

The starting identity head `02dd3b595ce9af863da2eb51f71ca1270f1acd2f` passed
[CI 37131923786](https://github.com/julia-script/silk/actions/runs/37131923786):
60 PASS, 0 FAIL, 329 Unsupported, 46 selfhostTrack pins.

The ordinary callable return/call head `2eda17bff056e4a662482735b94c39f7f00f581b` passed
[CI 37212293538](https://github.com/julia-script/silk/actions/runs/37212293538):
80 PASS, 0 FAIL, 313 Unsupported over 393 programs, with 59 selfhostTrack pins.
All 60 starting PASS programs remain PASS. The overall gain of 20 includes concurrent Step 7
and other upstream work; it is not a claim that Step 8 alone enabled all 20.

Thirteen existing programs moved from Unsupported at the starting head to PASS through callable
work: anonymous-callable-capture-modes, borrowed-capture-section,
callable-return-and-borrow-contracts, captured-exclusive-reference-parameters,
constrained-section-generic-owner, opaque-callable, operator-pipeline,
option-result-combinators, owner-typed-direct-section, relayed-section,
staged-callable-bindings, staged-callable-parameter and staged-callable-section.

This pin layer adds these eight previously verified PASS programs to both
`compiler/scripts/selfhostTrack.ts` and the B11 list in `.github/workflows/selfhost.yml`:

| Program | Coverage |
| --- | --- |
| callable-return-and-borrow-contracts | Original return environments and public use permissions |
| borrowed-capture-section | Borrowed supplied arguments |
| relayed-section | Callable forwarding |
| generic-item-pipeline-in-generic-owner | Already passing generic pipeline control |
| constrained-section-generic-owner | Complete enclosing owner evidence |
| owner-typed-direct-section | Exact owner parameter types |
| option-result-combinators | Ordinary library unions and callable combinators |
| opaque-callable | Direct opaque returned environment realization |

The lists grow from 59 to 67 selfhostTrack pins and from 24 to 32 B11 pins. The existing
six Step 8 pins retain anonymous, exclusive-reference, binding, parameter, pipeline and staged
section runtime coverage. No bootstrap corpus source is changed by this pin layer.

## Structured claims

| Contract | Independent source proof |
| --- | --- |
| Unnamed identity and abstract-body ordinals, including unselected static arms | SourceIndexCases: anonymousDeclarationsUseAbstractBodyOrdinals, anonymousReuseIncludesEnclosingBindings |
| Capture order, modes and moved-owner rejection spans | SemanticCases: anonymousBodiesRetainOrderedCaptureModes, anonymousCapturesRejectUnavailableOwners |
| Environment record layout and captured-owner glue | anonymousEnvironmentsUseCaptureOrderedRecords, anonymousEnvironmentGlueCleansOwnedCaptures |
| Shared, mutable and consuming direct invocation | anonymousSharedInvocationHasEnvironmentParameter, anonymousMutableInvocationHasEnvironmentParameter, anonymousOnceInvocationOwnsEnvironmentParameter |
| Consumed captures have one cleanup owner | anonymousConsumedCapturesBelongToEnvironmentOwner, anonymousBorrowedCallableCapturesRetainOneCleanupOwner |
| Original section target and trailing-argument order | namedSectionsAppendStoredArgumentsDirectly, stagedNamedSectionsFlattenCaptureOrder |
| Exact generic/constrained parameter representation | callableParameterInfersExactRepresentationAndSignature, plainCallableParameterSpecializesOwnedEnvironment |
| Mutable parameter storage loans and descriptor-only transport | plainCallableParameterForwardedMutableViewRetainsOriginalEnvironment, plainMutableCallableSectionViewProjectsBeforeStoredArguments |
| Returned environments and weaker public permissions | plainCallableReturnsKeepOriginalStorageAndPublicContracts, plainCallableViewsKeepWeakerInvocationPermissions |
| Stored/method producers and moved-once returned capture cleanup | plainCallableResultsFromStoredProducersAndMethodsUseOriginalTargets, plainOnceCallableReturnsTransferCaptureCleanupExactlyOnce |
| Raw callable return diagnostic role through aliases and enclosing captures | rawOwnedCallableReturnKeepsBootstrapIdentityGuard |
| Exact callable union injection, original target, canonical layout and active captured-member glue | callableUnionMembersRetainCanonicalStorageAndDirectTargets, plainOnceCallableReturnsTransferCaptureCleanupExactlyOnce |

These MIR assertions inspect original Function instance keys, environment Aggregate operands,
reference/move passes and exact Drop glue. A source closure does not introduce a dispatch pointer,
a section key or an adapter declaration. FunctionAddress remains reserved for the separate C
callback lane.

## Remaining first gaps

The following table is the observed first-gap sweep at `2eda17b`. Byte spans refer to the original
corpus sources; unsupported is not runtime coverage of later operations.

| Program | Observed gap and bytes | Owner |
| --- | --- | --- |
| anonymous-capture-cleanup-count | effect-form, main.silk 1463–1470 | Step 9 |
| anonymous-forwarded-once-capture-cleanup | effect-form, main.silk 1260–1267 | Step 9 |
| affine-checked-callback-cleanup | effect-form, main.silk 2398–2407 | Step 9 |
| stored-callable-terminal-cleanup | effect-form, main.silk 2097–2106 | Step 9 |
| stored-callable-drop-lane-mutation | effect-form, main.silk 2044–2051 | Step 9 |
| stored-callable-lazy-moved-effect | effect-form, main.silk 1209–1216 | Step 9 |
| stored-callable-cleanup-typed-failure | effect-form, main.silk 1065–1072 | Step 9 |
| effect-retry-captures | effect-form, main.silk 424–448 | Step 9 |
| constrained-callable-forwarding | effect-instance, effect.silk 24602–24864 | Step 9 |
| constrained-section-two-applications | effect-instance, effect.silk 24602–24864 | Step 9 |
| streaming-inflate | effect-instance, effect.silk 26121–26422 | Step 9 |
| finite-effect-join-selected-requirement | effect-instance, effect.silk 24602–24864 | Step 9 |
| finite-effect-join-selected-cleanup | effect-form, main.silk 1633–1640 | Step 9 |
| finite-effect-join | scalar-enum-moving-match, main.silk 136–214 | Moving enum match follow-up precedes effects |
| finite-effect-join-capture-arity | typed-form, main.silk 406–431, choose(First {}, payload) | Step 9 Effect-valued producer; later operations unmeasured |
| foreign-libc-qsort-callback | effect-form, main.silk 1264–1286 | Step 9 first; C callback lane unmeasured |
| bound-method-values | bound-method, main.silk 416–427, shared.read | Approved bound-method capture follow-up in MIR note §10 |
| method-call-matrix | typed-form, main.silk 1819–1850, Option.some<i32>(4).map(addOne) | Generic inherent-method inference follow-up; rejected before argument checking |
| constrained-section-owned-capture-lifecycle | CORPUS_NATIVE_LINK_INPUT before compilation | Runner/link-input follow-up; callable behavior unmeasured |

The broader callable/pipeline source sweep found 171 programs whose first gap is effect-form or
effect-instance. Other first gaps belong to ordinary call discovery, strings/constants, intrinsics,
entry signatures, byte literals, interfaces or runner inputs; their presence is not evidence that a
closure argument reached native checking.

One additional non-effect first gap was demonstrated: ordinary-union-executable-members stopped
at selectedCallable(), main.silk 244–262. The exact callable-union layer (#785) extends the existing
member admission/canonical ordering and checks the original target and active-member glue. Its
separate source assertion requires an Effect-valued union producer to report EffectFormUnavailable.
The exact-head CI receipt determines the corpus's next observed gap rather than treating a
source prediction as an executed result.

## Further return-shape coverage

Abstract higher-order producer results remain required Step 8 work: a constrained parameter such
as `P: fn<'static>() -> fn<'static>(i32) -> i32` must retain the selected producer's exact returned
environment after monomorphization. The current checker rejects that application before origin
normalization. Absence of an existing corpus first-gap witness does not remove it from scope.
Interface producer projections and recursive/divergent plain return origins also retain explicit
Unsupported boundaries; they are not claimed PASS. Contextual opaque
slots inside aggregate results and unresolved descriptor/phantom projection likewise retain explicit
projection limitations. Detached/nonParking executable-property proof belongs to the Effect/property
work. General escaping validity and parent-loan proof belong to Step 14. No producer adapter or
invented leaf identity is an acceptable substitute for those proofs.
