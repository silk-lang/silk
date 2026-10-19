# Semantic preparation and source routes — joint B repair proposal

2026-10-19. Design only; no implementation, native execution, compiler acceptance or new PR claim.
Environment owner contribution to finite author's single B repair publication. The finite author
owns the combined design/model and BorrowCheck implementation; environment owner owns eventual
Semantic preparation/routing, EnvironmentInput and all three checker call sites. The proposal
replaces the archived Vector-only route API, not a compatibility adapter. Archived WIP remains
107556130bf906445f5eb3330086dfd7a6265889962a86292e81ca2540295375, local 0849dadd8/86ac092b9.
Published PR1976 d69 remains blocked. Accepted main6c160865 includes PR1983, but this worktree is
not merged or built in this turn. No unpublished #1957 metadata is assumed implemented.

## 1. Concrete boundary: semantic descriptors before reservation

`Semantic.prepareSourceInputs` runs under the SAME active body `Query<Answer, NoRejection>` and
its dependency collector as `borrowCleanup`. It receives the immutable, complete finalized
body view, original owner/supplied lifetimes/premises, retained obligations and coverage. It
returns an owned `SourcePreparation`; no Resolver, Query or deferred callback crosses into
BorrowCheck. `BorrowCheck.prepare(..., cleanup, preparation, coverage)` consumes it, reserves the
one complete CFG/operation graph, then solves. No policy solution is used to decide which
semantic descriptor is requested. No descriptor lookup can demand a new query while solving.

The package contains finite indexed tables, not duplicate source names or source bodies:

- `ShapeId`: exact type evidence and its complete inline representation, member labels and
  payload ordinals; reference/slice/opaque boundaries are explicit. `KnownEmpty` is a positive
  shape answer, distinct from unreadable/unavailable shape. A nominal stores canonical
  DeclarationId plus exact Argument list, never merely region atoms or declaration spelling.
- `EndpointId`: typed value or storage port, representation shape, and optional original
  declaration-space type plus its `ApplicationEvidenceId`. Endpoints distinguish value
  snapshots from addressed storage. Structural fields, array classes and reference descriptors
  have ports even when the value has no Loan. LocalId/NodeId and endpoint role tie roots to the
  exact body; static evaluation occurrence expansion remains BorrowCheck's responsibility.
- `ApplicationEvidenceId`: original declaration owner and formal binder identities; original
  Signature or AppliedOperation answer facts; original parameter/result/failure/success types,
  premises and written-environment/exemption facts; final Binding map keyed by declaration AND
  ordinal; exact body call/argument identities. Keep original and applied endpoints distinct.
  The record need not retain an entire query answer if copied facts preserve these identities.
- `SelectionMapId`: a typed, finite edge map with source/target endpoints, semantic selector,
  and declaration/application evidence. Labels include Member(declaration, member, payload),
  Index(class), Referent, EffectSuccess, and identity/copy/placement maps. Index classes are
  exact authored constants plus remainder/may-overlap, never one allocation per array element.
  A map also identifies its original authored/metadata site. It does not assert source presence,
  directness, exact storage ownership, outlives, or permission to kill a definition.
- `ContractRouteId`: original input-component to result/success-component correspondence and
  the original-premise reason, before call binder coalescing. It includes input ordinal and
  original endpoint types; an edge identifies the specific original application. Ambiguous
  declared possibilities remain separate routes. Missing correspondence is not LoanFree.
- Request roots: obligation ordinal, exact call/operand identities, finalized required region,
  validated original application/exemption, and initial operand endpoint. No stored root path
  is added to EnvironmentInput. Other BorrowCheck consumers have their own typed selector roots.
- Coverage records and immutable semantic predicate inputs: known shape coverage, actual query
  rejections, genuine opaque boundaries, and original universal/contents/region facts needed by
  the fixed operation rules. Cleanup keeps its existing separate descriptor channel.

The package is sealed to the exact immutable body view and query revision which produced it.
The implementation must reject pairing it with a different node/local/obligation snapshot, even
if owner DeclarationId is unchanged. This is ephemeral invocation identity, not a new persisted
TypedBody field. Analysis consumes/owns the package and issues its own private stamp; package
indices alone cannot manufacture Analysis IDs or discharge an obligation.

## 2. Queries, ownership, substitutions, finite closure

All following demands occur BEFORE graph reservation through `demandChild` on the active body
query. Its dependency vector records successful AND unsuccessful answers. One-shot recording
may return early under existing repository policy; computed semantics must be identical.

1. Inventory complete typed locals, nodes, explicit projections/places/indices/Run sites,
   aggregate and callable captures, selected calls, existing result/kept-slot paths and all
   obligations. Include all statically expanded sites, whether policy will retain them or not.
   For no-loan requests this inventory is still mandatory.
2. Demand original `Family.Signature` for DirectCall's retained declaration. For InterfaceCall,
   demand `Family.AppliedOperation` with the retained original operation identity, contract and
   provider applications, exactly as operationEnvironmentSources currently does. Applying
   enclosing interface/provider arguments leaves the operation's own binders distinct. Preserve
   this intermediate answer, then separately record finalized operation Binding substitutions.
   No witness body or inferred caller-region matching supplies a correspondence.
3. Demand the member inventory (`Family.Members`, including its normal source/header dependencies)
   and `Family.MemberShape` for each needed inline nominal member/payload under its exact type
   application. The keys carry module/declaration/application/member as in storedMemberTypes;
   unlike that helper's flattened vector, the package retains member AND payload coordinates,
   status and type. Demands on a member answer carry its usual transitive dependencies. A loaded
   zero-member declaration can be KnownEmpty; source absence/failed MemberShape cannot become it.
4. Obtain the original signature-implied and explicit bounds used by
   `declaredResultPartSources`, including its tracked nominal well-formedness/member demands.
   Compile component correspondences in that declaration space. Resolve all endpoint/type
   facts required by operation predicates before sealing the package. Invoke existing bound
   proof machinery; do not add a stronger result-source rule or erase its conservative limits.
5. Compile all structural and declared selectors and compatible copy/placement maps. Traverse
   all inline owned fields needed for a whole-value transfer, stopping at reference/slice and
   genuine opaque type-parameter boundaries. For a generic field T, keep a symbolic whole T
   endpoint and its actual type identity/premises; do not pretend T has zero contents.
6. Validate endpoint coverage for every authored selector and declared route before success.
   A missing supported map is `PreparationFailure.MissingSupportedMap{site,endpoints}`, an
   implementation defect/noncertifying failure, NOT a legitimate UnknownSelection receipt.
   A rejected query keeps its actual diagnostic; RevisionMismatch/cancellation abandons the
   package. Truly unreadable/opaque declarations retain explicit shape status and type evidence.
   A whole opaque Entry can still be proved from an actual Contents premise without inspecting
   fields; an unavailable REQUIRED projection cannot be silently skipped or called complete.

Finite closure is over finite typed sites and their structural maps, NOT transitive concrete
unfolding of arbitrary referent types. Inline owned layout is finite under existing layout rules.
Recursive references stop inline expansion. A selector crossing one resumes at the endpoint
already demanded for that finite authored/contract selector site. Composition follows fixed maps;
it does not create a new concrete type application per traversal. An external selector cycle is
permitted only when its endpoint type/application maps have already been validated by typing.
For example Node<T> -> &Node<T> -> Node<T> can cycle; Node<T> -> &Node<List<T>> does NOT authorize
identifying Node<T> with Node<List<T>> or erasing T. A finite explicitly typed chain of the latter
has its finite distinct endpoints; an arbitrary unobserved unfolding is never demanded.

This suffices for copy/loop recurrence because a repeated source transfer composes existing
statically typed input/output maps. The source history can grow; the typed map inventory cannot.
External selectors name routes, not new storage objects, so separate selectors do not establish
owner disjointness. Endpoint equality needed to close a cycle includes the application identity
or an existing authenticated type/substitution equality. Similar retained-region sets are not
that equality. A new supported typed form lacking this construction is a design/implementation
blocker to fix, not permission to add a depth cutoff or relabel it Pending.

`SourcePreparation` is closed before reservation. Solving changes presence, paired RouteCase
applicability, losses and effects on fixed slots only. `sourcesAt` returns a view/product over
fixed ports and selector states; it cannot append components, ask Semantic to resolve a new
member, or restart the solver. The polynomial bound remains relative to the explicit finite
package plus body, not arbitrary source-level generic expansion.

## 3. Route access API (declaration sketch, not compiled Silk)

    prepare(current arguments..., preparation: SourcePreparation,
            coverage: AnalysisCoverage) -> Analysis
    sourcesAt(&Analysis, &SourceQuery { read: NodeId, selection: SelectionId }) -> Sources
    operandSelection(&Analysis, obligationOrdinal) -> Result<SelectionId, RouteAccessError>
    route(&Analysis, SourceRouteId) -> Result<RouteView, RouteAccessError>
    routePort(&Analysis, SourceRouteId, RoutePortId) -> Result<RoutePort, RouteAccessError>
    routeEdges(&Analysis, SourceRouteId, RoutePortId) -> Result<[RouteEdge], RouteAccessError>

SelectionId is an Analysis-stamped root of the precompiled selector graph. Environment requests
use the empty selection at their operand via operandSelection. Other consumers import an
existing prepared selector-site ID through a validated accessor, never submit arbitrary vectors
which the package was not constructed to support. Semantic's eventual internal API can combine
these views, but it must expose this information without a querying callback:

    RouteView { starts, accepts, coverage }
    RoutePort { endpoint: EndpointId }
    RouteEdge { from, to, map: SelectionMapId,
                originalContract: Option<ContractRouteId>, case: RouteCaseId }
    RouteCase { applicability: True | False | Undefined,
                witness: paired definition/read/transfer occurrence,
                direct, placement, sourceQuality, originalEvidence }
    SourceAlternative { leaf, actual source origin, occurrence, definition,
                        route: SourceRouteId, case: RouteCaseId }

These are schema requirements, not final field-layout commitments. Cases keep directness,
placement, precision and definition/read pairing conditional together. They must not be exposed
as independent unions that let Semantic combine one case's directness with another's field.
Effect identity includes target leaf/loan and output placement, as in the finite author's repair.
Normalizing histories does not merge different actual value components or count histories as
extra operands. Route coverage and applicability are separate: complete enumeration can contain
Undefined cases. False cases are excluded; undefined cases remain possible and supply no positive
witness. True denotes a grounded may-reaching route, not that every runtime execution takes it.
A conditional bad branch can therefore supply an exact refusal under the existing may-conflict
semantics; Undefined denotes unresolved analysis applicability, not an ordinary runtime branch.
MissingEvaluation/Unknown/Recovery remain explicit; an absent vector is never success.

All route/port/selection/case IDs are valid only for the Analysis instance. Access rejects foreign
IDs; no raw-index fallback. IDs and Analysis are neither cached nor rebased into another body.
Read occurrence identity remains explicit when one NodeId is structurally evaluated repeatedly.
Endpoint/application evidence is immutable and accessible through Analysis-owned package views.
No caller must use a mutable Resolver to decode a route.

## 4. Product proof: traversal is not outlives evidence

Semantic evaluates the finite product of (route port, original application/endpoint evidence,
required predicate, paired case/occurrence context). Required predicates come from retained
obligations and the finite endpoint/premise facts; traversal does not synthesize longer types or
new regional predicates on each cycle. Reserve PredicateIds from the finite original-obligation
by endpoint by application by case product before solving; a cycle reuses those IDs and its
verified substitution maps. A needed transformation outside that inventory is a construction/
design blocker, not an accepted Pending gap. Member/index/referent/success maps transform the
selected endpoint under their authenticated maps. Copy and identity follow the same selected component.
Original-contract transitions preserve input ordinal and declaration-space field/success route.
A Local read delegates to this same Analysis; no lexical scan or second CFG is introduced.

The visited set prevents repeating an identical product state. Encountering it proves ONLY that
its outgoing route coverage is already scheduled. It never proves Contents, Outlives, source
presence, or a required acceptance. Compute accepting-state reachability/coverage and retain all
terminal proof obligations. A reachable cycle with no grounded accepted source is an ungrounded
or incomplete route, not a vacuous all-leaves proof. A cycle plus a grounded entry must check that
entry's actual predicate. An explicitly unreachable operand retains nonexecution evidence under
existing CFG semantics; absence alone cannot manufacture it.

At every possible accepting alternative:

- Entry retains its actual parameter/capture type and original caller premises. Prove its exact
  selected Contents/Outlives requirement with those facts; 'Entry' is not inherently universal.
- Borrow retains its actual loan/optional typed Borrow node, read/storage provenance and origin.
  Only an applicable, independently grounded source/owner/region proof can yield a hard refusal
  at that source. Possible presence or Undefined route applicability alone cannot do so.
- Expression routes through the prepared original call/component maps or its actual structural
  RHS, preserving selected success depth and source correlation. Expression itself is not safe.
- LoanFree requires the actual positive nonretaining/definition proof; it is not the complement
  of the Loan set. Unknown/unreadable required interpretations remain noncertifying.

Universal success requires coverage plus a proved acceptance for EVERY possible source route,
with no unresolved mandatory guard/proof in its dependency slice. It cannot select one convenient
source, drop a mixed local atom, assume an absent loss bit false, or use complete enumeration as
proof of applicability. Undefined applicability cannot authorize release or refutation; it does
not prevent using a separate fully grounded independent refusal. Grounded Stored/Alternatives
losses are consumed from the shared analysis; Semantic performs no private quality fixed point.

Remaining after solving: genuine caller Contents/Outlives discharge, exact owned-source refusal,
all original rigid written-environment constraints, ordinary region/availability/ownership rules,
and required coverage/applicability checks. These use immutable prepared semantic facts and solved
source facts; no predicate may discover a new component. Any semantic proof needing further
shape demands must have its finite dependencies included in preparation, not cause a late rerun.

## 5. Worked constructions

A. Nominal copy and exact overwrite (schematic source, not executed):

    Pair<T> has left:T, right:T; entry:Pair<&'p i32>
    let mut q = entry
    q.right = &bad
    use(q.left); use(q.right)

Semantic demands Pair's Members and BOTH MemberShapes for Pair<&'p i32>, even with no Field in
the initializer. Entry has a whole pair root and left/right inline endpoints. Both field types
substitute Pair's T with &'p i32; leaf predicates retain caller 'p. The copy creates a q value
snapshot with each component's paired Entry read witness. The exact owned right assignment
kills q.right's earlier real definition and supplies its actual borrow source. It cannot kill
q.left or the entry's right storage, and shadow history stays in its separate role. A prior
`saved=q` keeps the earlier q read; a backedge to a later q read sees the replacement according
to the one CFG. This descriptor supplies boundaries, not a new field-alias exemption. A computed
index/reference/opaque write uses existing may-overlap rules and is not an exact whole kill.
The pair can be wholly caller-only/no-loan; definitions and endpoints still exist.

B. Recursive external selector:

    Node<'p> { next: &'p Node<'p>, value: &'p i32 }
    cursor = entry; while (...) { cursor = cursor.next }
    use(cursor.value)

The complete typed body gives a finite next selector site, a referent map, a value site and a
compatible cursor-copy map. Semantic queries Node<'p>'s inline shape and these typed endpoints
once per exact application. Entry is external; no owned Node is invented. BorrowCheck can place
the next/referent/copy relation in a cycle tied to the same typed endpoint, with zero-iteration
entry and backedge witnesses. A source route represents next* then value using fixed vertices;
it does not allocate next.next... field vectors. The product checks every accepted value's
actual &'p evidence against required, e.g. 'p:required. Revisiting Node's port does not establish
that predicate. Distinct source nodes represented by the cycle do not become disjoint owners.
A different generic application cannot enter this cycle without genuine typed compatibility.

C. Original result/success and sibling binders:

    Maker.pair<'a,'b>(left:&'a i32,right:&'b i32)
       -> Effect<...; Effect<...; Pair<'a,'b>>>
    pending = run maker.pair(x, &bad)
    value = run pending
    use(value.right)          // paired left selection is the valid control

Use the operation's AppliedOperation answer: enclosing contract/provider substitutions are
applied, operation 'a and 'b remain distinct. Prepare Success->Success->Member(right) on that
ORIGINAL result. Pair's MemberShape is queried with those declaration-owned arguments. The
selected endpoint names 'b; original directed bounds determine the permitted input-component
routes, with right input ordinal retained. Only after this correspondence is fixed does the
final Binding map produce caller-facing required types. If inference makes actual a==b, that
does not introduce a left-to-right route. If the original declaration itself permits both via
its predicates, both routes must remain and both must be safe. No witness body is inspected.
Staging copies the Effect value/source route through real reads; each Run selects one success
edge, including arbitrarily many FINITELY written nested successes. The right route reaches
&bad's real read/source origin; left route does not inherit right merely from all captures.
Reference results add the explicit Referent edge; they are not silently treated as Member-only.
No diagnostic/result status is claimed for these schematic snippets without compiler assertions.

## 6. Lifecycle, section metadata, publication and ownership

Ordinary bodies, complete anonymous ClosedBody/CheckedLiteral bodies, and finalized derived
Effects prepare AFTER their node/local/obligation graph is complete and after final binding
selection. Retain EnvironmentInput {origin,call,operand,argumentOrdinal,required}; original rigid
RegionRelation/Contents obligations stay immediate and retained. Rechecked Effects discard
first-pass package/source facts and build from the final graph. Environment clone/rebase maps
call AND operand NodeIds and lifetime ownership under the existing obligation mapping, then
rebuilds the ephemeral package; no copied Analysis or stale provisional static required region.
Main1981 shortened-site lifecycle and later accepted anonymous changes must remain intact.

Selected section/capture metadata is an additional descriptor INPUT owned by the #1957 author,
not permission to infer semantic retention from runtime recipes. Both Aggregate named producers
and StagedCallable producers need their real capture endpoints. Capture ordinal maps to the
selected full signature parameter: named first+i; staged base is distinct, remaining+i for
suffix captures. Retention's originalInference and inferred bindings use its exact fresh
DeclarationId.inference and dense ordinals; runtime remapping to target ordinals is separate.
A deferred named original-signature/noBindings runtime recipe is not closed semantic evidence.
KeptRegions/KeptSlot paths retain declaration-space type/lifetime owners and structural paths.
Missing binding/row substitutions cannot be invented. Actual inference/recheck must rebuild the
record; environment node rebasing maps operands but cannot synthesize owners or closure.

No final #1957 schema is assumed. Before implementation, environment/finite authors must agree
with holder owner on exact metadata fields and clone seam; environmentExpression is a known
future overlap. This proposal consumes an authenticated descriptor or explicit unresolved state,
not an open recipe fallback. A previously supported complete section must not be made Pending
merely because the new package omitted its metadata. The accepted PR1983 caller-retention and
literal-condition applicability policy is the migration baseline, not an unpublished classifier.

All three Semantic checker sites use this boundary; no-loan requests still prepare. Recovery
packages/analyses remain incomplete and cannot certify outcomes. A package from an abandoned
query is discarded; no facts are published across mismatched body revisions. A MemberShape,
original Signature/AppliedOperation, bound, section-selection or source dependency change
invalidates the owning body through recorded query dependencies and forces fresh preparation.
Analysis/route stamps never become persistent revision caches.

One requestOutcome per exact retained obligation ordinal uses Analysis's private stamp;
foreign, missing, duplicate or wrong-kind outcomes remain Pending. Only checkPrepared consumes
the Analysis and terminal outcomes once. No wildcard localRelationsProved branch accepts
EnvironmentInput. Checked requires all mandatory obligations discharged; partial recovery
cannot publish Checked even if a subset of requests happens to be provable.

Diagnostic origins distinguish call/request origin from actual offending source origin. Preserve
existing guard-consumption/nonreturn lifetime/outside/event-conflict/region ordering, with the
explicit environment refusal phase and prior localEscape OWN0019 control audited at integration.
Do not replace this precedence with a global source-span sort. Independent source refusals keep
stable structural request/source order and existing diagnostic deduplication. Undefined source
interpretation must not invent a hard diagnostic or mask an independent ordinary conflict.

## 7. Review and implementation obligations, not acceptance claims

- Finite author incorporates this package/route contract with paired directness/placement and
  grounded loss amendments into ONE B publication/model. Review its finite typed map construction
  and product admission, not merely a generic graph reachability theorem.
- Environment author later implements tracked preparation and all lifecycle/schema/consumer
  changes; finite author implements one source/CFG analysis, route access and terminal checker.
  Holder owns section semantic metadata and its BorrowCheck capture consumer. Coordinate exact
  overlaps first. No production edit or build is authorized by this document.
- Structured compiler assertions must cover copied nominal caller/no-loan values, exact field
  kills, computed-index non-kills, referents, recursive selectors, original direct/interface
  success/reference good and bad siblings, loop backedges/kills and saved prewrite positives.
  Retain existing full prefix/code/span controls, static demands and all environment controls.
- Add lifecycle/stamp/revision tests: original operation/member edits invalidate preparation;
  anonymous clone and derived recheck preserve operands/final required; foreign routes/outcomes,
  multiple evaluation occurrences, missing shape, no-loan requests and Recovery cannot certify.
  Both revisable and one-shot dependency-recording modes must compute the same answers.
- Missing supported descriptor/map is a construction failure to fix. Genuine language/proof
  limitations remain explicitly distinguished; no new gap baseline or unconditional Unknown
  fallback is approved. Current complete-body implementation, diagnostics, performance and
  corpus preservation remain unexecuted and require future independent review/native evidence.

## 8. Joint agreement and cross-check

Finite author acknowledged the package, stamped SelectionId/SourceRouteId interface, original
AppliedOperation/final Binding split, nonvacuous route proof and section constraints, and will
include this contribution in compiler/borrow-source-preparation.md as part of the SINGLE combined
B publication. Its fields/signatures remain design-level; this is not implementation approval.
The additional finite PredicateId requirement above incorporates the author's tightening.

Read the complete repair1/normalization-precision.md amendment: paired RouteCases preserve
direct/placement/read correlation; alternative histories share one scan position and incoming
state, real repeated components have sequential versions; effect IDs retain target and placement.
S/A loss bits require actual source presence, positive generators and real transfer edges. No
source identity/route coverage can stand in for a quality or applicability proof. The proposal's
all-possible accepting-case rule is compatible with those amendments; exact semantic source
refutation still requires an applicable grounded route. Finite author's call-write/outside/
diagnostic translation and models remain their work; none is presumed executed by this file.
