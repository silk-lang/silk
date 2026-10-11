# Step 8 callable coverage

This receipt belongs to [#567 Step 8](https://github.com/julia-script/silk/issues/567).
The implementation layers are merged through #802. Step 8 remains unchecked while ordinary
named lifetime-section recipes still require implementation. The current integrated source head
`0f2a900e06ebe9de9d35daa56038a6c66bf5e729` has native assertion and corpus evidence below.
Julia authorized timing-only failures to merge with timing repair as a follow-up.
The remaining timing work and skipped later CI stages are recorded explicitly; native borrow
obligations remain NotChecked until Step 14.

## Corpus evidence

The starting identity head `02dd3b595ce9af863da2eb51f71ca1270f1acd2f` passed
[CI 37131923786](https://github.com/julia-script/silk/actions/runs/37131923786):
60 PASS, 0 FAIL, 329 Unsupported, 46 selfhostTrack pins.

The ordinary callable return/call head `2eda17bff056e4a662482735b94c39f7f00f581b` passed
[CI 37212293538](https://github.com/julia-script/silk/actions/runs/37212293538):
80 PASS, 0 FAIL, 313 Unsupported over 393 programs, with 59 selfhostTrack pins.
The pin layer `e225c2f8eb302cc0a34549db7deeb57172a67b16` passes
[CI 37220392157](https://github.com/julia-script/silk/actions/runs/37220392157):
80 PASS, 0 FAIL, 313 Unsupported, track 67, with all 472 source tests under one second.
All 60 starting PASS programs remain PASS. The overall gain of 20 includes concurrent Step 7
and other upstream work; it is not a claim that Step 8 alone enabled all 20.

Thirteen existing programs moved from Unsupported at the starting head to PASS through callable
work: anonymous-callable-capture-modes, borrowed-capture-section,
callable-return-and-borrow-contracts, captured-exclusive-reference-parameters,
constrained-section-generic-owner, opaque-callable, operator-pipeline,
option-result-combinators, owner-typed-direct-section, relayed-section,
staged-callable-bindings, staged-callable-parameter and staged-callable-section.

This pin layer adds these eight previously verified PASS programs to both
`compiler/scripts/selfhost-track.json` and the B11 list in `.github/workflows/selfhost.yml`:

| Program                                | Coverage                                                |
| -------------------------------------- | ------------------------------------------------------- |
| callable-return-and-borrow-contracts   | Original return environments and public use permissions |
| borrowed-capture-section               | Borrowed supplied arguments                             |
| relayed-section                        | Callable forwarding                                     |
| generic-item-pipeline-in-generic-owner | Already passing generic pipeline control                |
| constrained-section-generic-owner      | Complete enclosing owner evidence                       |
| owner-typed-direct-section             | Exact owner parameter types                             |
| option-result-combinators              | Ordinary library unions and callable combinators        |
| opaque-callable                        | Direct opaque returned environment realization          |

The lists grow from 59 to 67 selfhostTrack pins and from 24 to 32 B11 pins. The existing
six Step 8 pins retain anonymous, exclusive-reference, binding, parameter, pipeline and staged
section runtime coverage. No bootstrap corpus source is changed by this pin layer.

## Structured claims

| Contract                                                                                          | Independent source proof                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unnamed identity and abstract-body ordinals, including unselected static arms                     | SourceIndexCases: anonymousDeclarationsUseAbstractBodyOrdinals, anonymousReuseIncludesEnclosingBindings                                                                                                             |
| Capture order, modes and moved-owner rejection spans                                              | SemanticCaptureCases: anonymousBodiesRetainOrderedCaptureModes, anonymousCapturesRejectUnavailableOwners                                                                                                            |
| Environment record layout and captured-owner glue                                                 | anonymousEnvironmentsUseCaptureOrderedRecords, anonymousEnvironmentGlueCleansOwnedCaptures                                                                                                                          |
| Shared, mutable and consuming direct invocation                                                   | anonymousSharedInvocationHasEnvironmentParameter, anonymousMutableInvocationHasEnvironmentParameter, anonymousOnceInvocationOwnsEnvironmentParameter                                                                |
| Consumed captures have one cleanup owner                                                          | anonymousConsumedCapturesBelongToEnvironmentOwner, anonymousBorrowedCallableCapturesRetainOneCleanupOwner                                                                                                           |
| Original section target and trailing-argument order                                               | namedSectionsAppendStoredArgumentsDirectly, stagedNamedSectionsFlattenCaptureOrder                                                                                                                                  |
| Exact generic/constrained parameter representation                                                | callableParameterInfersExactRepresentationAndSignature, plainCallableParameterSpecializesOwnedEnvironment                                                                                                           |
| Mutable parameter storage loans and descriptor-only transport                                     | SemanticCallableCases: plainCallableParameterForwardedMutableViewRetainsOriginalEnvironment, plainMutableCallableSectionViewProjectsBeforeStoredArguments                                                           |
| Returned environments and weaker public permissions                                               | plainCallableReturnsKeepOriginalStorageAndPublicContracts, plainCallableViewsKeepWeakerInvocationPermissions                                                                                                        |
| Stored/method producers and moved-once returned capture cleanup                                   | plainCallableResultsFromStoredProducersAndMethodsUseOriginalTargets, plainOnceCallableReturnsTransferCaptureCleanupExactlyOnce                                                                                      |
| Higher-order producer/leaf identity, nested free application/capture channels and affine cleanup  | CallableResultCases: higherOrderCallableResultsKeepSelectedProducerAndLeafTargets, higherOrderNestedCaptureOriginsNormalizeOriginalApplicationChannels, higherOrderAffineArgumentsAndOnceResultsHaveOneCleanupOwner |
| Selected invocation lifetime proof without physical retention                                     | CallableResultCases: deferredCallableResultRetainsSelectedLifetimeEvidence                                                                                                                                          |
| Raw callable return diagnostic role through aliases and enclosing captures                        | rawOwnedCallableReturnKeepsBootstrapIdentityGuard                                                                                                                                                                   |
| Exact callable union injection, original target, canonical layout and active captured-member glue | callableUnionMembersRetainCanonicalStorageAndDirectTargets, plainOnceCallableReturnsTransferCaptureCleanupExactlyOnce                                                                                               |

These MIR assertions inspect original Function instance keys, environment Aggregate operands,
reference/move passes and exact Drop glue. A source closure does not introduce a dispatch pointer,
a section key or an adapter declaration. FunctionAddress remains reserved for the separate C
callback lane.

## Remaining first gaps

The following table is the exact integrated first-gap sweep from
[CI 37308766103](https://github.com/julia-script/silk/actions/runs/37308766103) at `0f2a900e0`.
Byte spans refer to `main.silk` unless a module is named. The indicated operations were checked
against the actual corpus source bytes. An unsupported provider section is not runtime proof of
the later closure or cleanup operations.

| Program                                     | Observed gap, bytes and operation                                      | Owner                                                                          |
| ------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| anonymous-capture-cleanup-count             | typed-form, 821–865, `Effect.provideMut<Allocator>(&mut allocator)`    | Step 9 provider lifetime/row sections                                          |
| anonymous-forwarded-once-capture-cleanup    | typed-form, 846–890, same explicit provider section                    | Step 9                                                                         |
| affine-checked-callback-cleanup             | provider-section, 1612–1645, `Effect.provideMut(&mut allocator)`       | Step 9                                                                         |
| stored-callable-terminal-cleanup            | provider-section, 1157–1190, implicit provider section                 | Step 9                                                                         |
| stored-callable-drop-lane-mutation          | typed-form, 1224–1268, explicit allocator provider section             | Step 9                                                                         |
| stored-callable-lazy-moved-effect           | typed-form, 566–610, explicit allocator provider section               | Step 9                                                                         |
| stored-callable-cleanup-typed-failure       | provider-section, 749–782, implicit provider section                   | Step 9                                                                         |
| effect-retry-captures                       | effect-form, 424–448, `Effect.catchAll(recover)`                       | Step 9                                                                         |
| constrained-callable-forwarding             | typed-form, 511–542, `Effect.provide<Counter>(&fixed)`                 | Step 9 provider lifetime/row sections                                          |
| constrained-section-two-applications        | typed-form, 438–469, same explicit Counter provider section            | Step 9                                                                         |
| streaming-inflate                           | typed-form, 42147–42191, explicit allocator provider section           | Step 9                                                                         |
| finite-effect-join-selected-requirement     | typed-form, 954–988, `Effect.provide<RightClock>(&right)`              | Step 9                                                                         |
| finite-effect-join-selected-cleanup         | provider-section, 1093–1126, implicit provider section                 | Step 9                                                                         |
| finite-effect-join                          | scalar-enum-moving-match, 136–214                                      | Moving enum match follow-up precedes effects                                   |
| finite-effect-join-capture-arity            | effect-form, 406–431, `choose(First {}, payload)`                      | Step 9 Effect-valued producer; later operations unmeasured                     |
| foreign-libc-qsort-callback                 | c-abi-callback, 247–490; intrinsic-member, silk/pointer.silk 5029–5046 | C callback and pointer intrinsic follow-ups                                    |
| bound-method-values                         | receiver-capturing sections, expected result 58                         | Shared, mutable and consuming receivers use their original parameter ordinals |
| method-call-matrix                          | typed-form, 1819–1850, `Option.some<i32>(4).map(addOne)`               | Generic inherent-method inference follow-up; rejected before argument checking |
| constrained-section-owned-capture-lifecycle | CORPUS_NATIVE_LINK_INPUT before compilation                            | Runner/link-input follow-up; callable behavior unmeasured                      |

No program in the complete 393-program receipt reports `pipeline-callable`. A separate lexical
source scan for anonymous/callable syntax or `|>` selects 206 candidates: 11 PASS, 195 Unsupported,
0 FAIL. This scan is an orientation aid, not a semantic inventory of callable uses. Many programs
stop at providers, core types, runtime constants, intrinsics, borrow relations or runner inputs
before any callable operation is checked. The targeted table above records the callable handoff
programs and their concrete remaining owners.

One additional non-effect first gap was demonstrated: ordinary-union-executable-members stopped
at selectedCallable(), main.silk 244–262. The exact callable-union layer (#785) extends the existing
member admission/canonical ordering and checks the original target and active-member glue. Its
separate source assertion requires an opaque Effect-valued union producer to report EffectFormUnavailable.
[Exact CI 37220361315](https://github.com/julia-script/silk/actions/runs/37220361315) at
`fc0230930960ff4bfe37c9fde9b68f2ed2462494` observes effect-form at main.silk 270–286 for
ordinary-union-executable-members and at 406–431 for finite-effect-join-capture-arity.
The callable-union admission is followed by the Step 9 producer boundary in both cases.

## Further return-shape coverage

Higher-order producer results, finite recursive origins, opaque record fields and selected interface
results landed through #788, #791, #792 and #793. Their exact integrated head
`244d4883ce44c0817f6619655ac768170e15d960` reports 82 PASS, 0 FAIL, 311 Unsupported, track 69 in
[CI 37257790739](https://github.com/julia-script/silk/actions/runs/37257790739), preserving all 80
previous PASS programs. All 32 callable-result assertions passed; the only failure was the former
one-second timing gate. Julia explicitly authorized those merges with timing repair as follow-up.
The two additional PASS programs belong to concurrent Step 9 work.

Opaque union projection and collision controls merged in #797. Its accepted integrated head
`cc56cbe89c42e5026cc71ed91e642261694b6868` reports 83 PASS, 0 FAIL, 310 Unsupported, track 69 in
[CI 37264880579](https://github.com/julia-script/silk/actions/runs/37264880579), with all 43 callable
controls passing. The one new PASS belongs to concurrent Step 9 Effect-literal work.

Ordinary anonymous callable parameters merged in #801. Exact head
`8c851ec460484bf2ab8998e4067c8b813754402e` reports 84 PASS, 0 FAIL, 309 Unsupported, track 70 in
[CI 37308603747](https://github.com/julia-script/silk/actions/runs/37308603747), with all 48 callable
controls passing, including the repaired SEM0212 retained-environment rejection. The additional
PASS is Step 9's effect-ensuring-fallible-finalizer; all 83 parent PASS names are preserved.

Contextual opaque aggregate result construction merged in #802. Exact integrated head
`0f2a900e06ebe9de9d35daa56038a6c66bf5e729` reports **84 PASS, 0 FAIL, 309 Unsupported, track 70** in
[CI 37308766103](https://github.com/julia-script/silk/actions/runs/37308766103), preserving exactly
the parent's 84 PASS names. The current B11 list has 35 pins. All thirteen callable gains listed
above are pinned in selfhostTrack and B11; no new corpus source or pin is needed for #797/#801/#802.
The total increase from 60 to 84 PASS includes concurrent Step 7 and Step 9 work.

This current run executes 21 formatter, 14 query/source-index, 382 semantic and 52 callable-result
controls uncached, all with zero assertion failures. Its four new aggregate controls prove exact
record/tuple storage and original direct targets, nested fixed arguments and written evaluation
order, incompatible contracts, repeated-family divergence at MIR realization, and ordinary
assignment rejection. A reused native executable at the same head independently passes all 52
callable controls on macOS through the admitted Uncached test exchange.

The sole CI failure is the timing guard: interfaceCallableResultsKeepSelectedOriginalTargets
measures 2000 ms. Six other callable controls exceed the 1 s target but stay below the 2 s failing
limit. Julia explicitly waived timing-only merge failures; the timing follow-up retains every
distinct assertion. Frozen target/HIR tests and the later B11 script were skipped after that guard,
and are not claimed executed. Every current B11 pin was separately checked against the exact
native corpus PASS set for this receipt.

Independent production, test and integration reviewers accepted each layer before merge. Complete
MIR, exact Drop glue and EmissionPlan identities from Step 7, and deriving Effect return channels
from Step 9, remain intact. No source callable adds an adapter or function pointer.

## Remaining follow-ups

Named quantified sections and deferred requirement rows retain their existing Unsupported/typed-form
boundary; Effect provider sections belong to Step 9, while ordinary named lifetime-section recipes
remain required Step 8 work. Result-only section inference, runtime static operands and unapplied
owner recipes remain separately documented selection boundaries. Bound method values belong to
MIR note §10. These gaps do not substitute an adapter or an invented runtime callable identity.

Unresolved representation-sensitive recursive descriptor projection retains the precise union-form
follow-up; this conservative ABI boundary does not prove every such source has incompatible storage.
Omitted callable-field environment binders retain their declaration-span Unsupported control.
Detached/nonParking executable-property proof belongs to Effect/property work; general escaping
validity and parent-loan proof remain Step 14. C callbacks remain c-abi-callback.

The [timing follow-up (#807)](https://github.com/julia-script/silk/issues/807) is prepared for cloud execution. The available Cloud account currently lists
no repository environments, so no cloud task has been launched and no local build is assigned to it.
