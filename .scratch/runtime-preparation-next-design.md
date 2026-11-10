# Retained runtime preparation: next measured candidate

Status: source-only design, based on checked-plan source `05b786d0f` over V22. No implementation or savings claim. The frozen checked-plan candidate is unchanged. Semantic integration: worker_forks; independent proof/ownership review: interning.

## What is actually repeated

`Semantic.lowerRuntime` currently executes the same ordinary-function preparation for Family.RuntimePlan and Family.Mir. The final branch selects `MirFunction.plan` or `MirFunction.lower`; both receive separately rebuilt argument tables. Body/Signature query answers can already be green, so this is **not evidence of duplicate Body provider runs**.

The repeated work is concrete and substantial in source: select/residualize Body; derive exact caller bindings and runtime signature lanes; `runtimeProjections`; `cleanupNeeds`; enumerate `MirFunction.callNodes`; close applications; prepare composite Effect, carrier, storage and witness plans; construct call operands/static slots; select/provide each callee requirement; compute provider addresses, partial remainders, entry NonParking obligations and body constants. The call loop occupies roughly 360 lines in lowerRuntime. These operations allocate selected tables and may demand many already-cached semantic queries. A second sink currently reconstructs them even in the same retained worker.

The initial small CLI diagnostic recorded compact261, oracle19 and MIR346. These are event totals, not exact-key overlap or saved CPU; they cannot establish how many of those346 MIR starts repeated one of the261 preparations. Historical V24 MIR duplication counts concern a different pipeline and do not measure this newly introduced plan→MIR repetition. No defensible seconds estimate exists yet. Actual package counters and matched cold/edit controls remain prerequisites.

## Smallest useful structural move

Add one ordinary-instance `RuntimePreparation` query, shared by RuntimePlan and Mir. It owns the completed immutable input recipe immediately before the current `sourceAnswer/packageRoot` tail. Both consumers record the Preparation UnitResult dependency before reading the result. No query RPC, capsule encoding, process-shared pointers or new worker protocol is required: retained artifact routing already preferentially visits the definition's checker owner. Other owners compute their own recipe through the same query on a miss.

Use exact application/provider/static/region-pattern identity, selected target/profile/application/query scope, with observing and frame *excluded only from this common ordinary preparation*. The current ordinary common section does not branch on observing. Its source/query guard must still include every existing demand and selector, including Condition/request dependencies; no hand-picked reduced guard. Exact key selection must not change global definition-normalized finite budgets. Unsupported generated/Export/DropGlue/union/frame paths remain explicitly represented, not coerced into an ordinary recipe.

Candidate payload:

- Retained `Shared<TypedBody>` plus exact instance and closed result/failure/runtime parameters/provider addresses.
- Prepared calls (including pre-canonical application, provider sources, cleanup edges, failure widening and NonParking flags), run plans, storage plans, carrier plans and witness intrinsics.
- Cleanup needs, runtime projections, partial remainders, entry obligations and constants.
- Stable source/declaration identity and raw body anchor. No borrowed HIR/SourceIndex pointers or local query-unit IDs inside the payload.

Do not retain the source Signature answer just to retain its dependency: the normal query edge supplies validity, while the payload stores only values the materializer uses. Source/type/body handles must remain owned and local to the store; this proposal does not make thread-local Shared transferable.

## Keep mode-specific evidence separate

The common section ends before `sourceAnswer`, `reportRoot`, global observing/line-table source reads, frame expansion and executable verification. Materialization must still acquire the current immutable source view under the selected query guard, perform whole-file reads when observing or line tables require them, and record application-report inputs. Putting those reads on common preparation would broaden ordinary check invalidation. Preserve raw origins and anchor them only at the same diagnostic/reporting boundaries. Feature/inlining/size attributes can remain in the consumer initially; moving them is not necessary for the first benefit.

Plan and Mir keep distinct query answers and capability types. A Preparation is neither a proof nor executable MIR; a completed RuntimePlan still requires all compact logical control/projection work, and a Mir answer still requires executable materialization/coalescing and explicit verifyMir. Helper groups must have exact creator-owned ranges, with observing-specific generated rows.

## Ownership conversion, not deep-copy reuse

Mir's prepared calls, remainders, cleanup needs, projections, constants and witness intrinsics are read-only. The three destructive seams are `takeStorage`, `takeCarrierPlan`, and `takePlan`, which remove rows to acquire ownership. Change these to immutable row access with per-materialization consumed-index state. Any transformed values belong to the local Builder; do not mutate the retained recipe or deep-copy every nested RunPlan for each sink.

A store-owned preparation table indexed by the query answer is sufficient. Its immutable borrow can remain live during a materializer that makes Types calls but no Semantic/Query demands; publication into resolver MIR/proof arrays follows after that borrow ends. Retain actual source owners when necessary, never references into reallocating resolver tables. Failures/OOM publish no partial preparation. Cycles continue through normal Query reservations rather than in-flight waits.

## Memory and validation tradeoff

Retaining all selected tables extends their lifetime beyond compact checking. It can consume more memory than the omitted CFG for call-heavy/static-expanded bodies, and fork children inherit prepared prefixes. Start with a command-lifetime table and bounded explicit retention policy; do not silently make check-only runs retain unbounded build recipes. A normal cache stores dependency/proof evidence, not this local recipe. Discardable recipes need a clear recomputation state, not a fake completed query answer pointing to freed data. Measure peak aggregate PSS and retained rows/bytes before promotion.

The first implementation should prove one exact preparation provider run serves compact plan then executable materialization in both request orders, while observing false→true adds the correct consumer-only evidence. Preserve existing full proof-equivalence cases, exact opposite region patterns/helper cases, changed callee header/provider/static/body/roster/application invalidation, failed preparation retry, explicit verification and finite-budget refusal. Native cold→direct edits→unchanged must match serial fresh diagnostics/runtime/artifacts. Count preparation provider starts, prepared consumer hits, retained payload sizes and mode-specific rematerialization separately; counts alone cannot claim speed.

Recommendation: the largest safe move is the whole selected semantic preparation block, not another completed-MIR cache or eager parent precheck. It addresses concrete newly duplicated work while retaining current private query-store and worker ownership. Implement only if checked-plan workload controls show this duplication materially limits build reuse.

## Measurement and implementation checkpoint

The checked-plan full build later recorded45,017 compact completions (44,873 ordinary,144 storage,12 generated helper proofs),3,106 executable-backed proofs (3,103 glue,3 export), and43,279 MIR provider starts. These remain aggregate events, not exact-key intersection. Matched four-core controls improved cold check10.834→10.214s but worsened cold build19.547→21.693s and buildCPU61.558→65.516s. CPU0 build47.341→51.318s also regressed. The check-only sink is rejected as a final candidate.

Root authorized the preparation cut in a separate worktree `.scratch/runtime-preparation`. Frozen source9add3421ba5f86be772e89d22114ef50258eb0da contains Semantic integration and backend78234fb50. Both ordinary consumers now demand one exact non-observing/no-frame preparation query, with their normal scoped context and complete preparation dependency graph. Owned recipe tables are borrowed by the backend and consumption lives in fresh builder-local index lists. Entry obligations are copied only into the output proof/MIR that owns them. Observing/line-table/report/frame reads remain consumer-specific. Export/glue/helper/storage/union special cases retain their explicit paths. Full-source/focused validation is scheduled; not yet validated or measured.

This cut executes semantic selection/preparation once, but still executes the common typed-body control/lowering engine once per requested output capability. Direct materialization without revisiting TypedBody would require a substantially richer recipe than RuntimeProof: all value/place operations, local identities, branch/merge structure and cleanup transitions sufficient to emit executable statements. A dense event/operand arena could encode that once and lower it later, but that reinstates much of the storage the compact sink intentionally omitted. It is a separate IR redesign with a different memory tradeoff, not a free extension of the selected-call recipe. First measure this bounded preparation reuse; do not represent it as once-only full lowering.

Validation checkpoint: `caff67cf8` passed whole-production sourcecheck and12 focused native tests, zero cached. New tests prove one actual preparation provider serves Plan→Mir and Mir→Plan in both observing modes, callee-header invalidation with unchanged caller source and recovery after failure, immutable package/helper recipe reuse, and exact creator helper-group boundaries. Two initial backend lifetime/type declaration errors were repaired; no proof assertion weakened. Receipt `.scratch/runtime-preparation-caff67cf8-focused.json`. All processes reaped. Optimized CLI/workload and peak-memory gates remain pending; no speed claim.
