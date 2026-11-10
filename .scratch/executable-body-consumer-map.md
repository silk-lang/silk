# Immutable executable bodies and exact logical MIR instances

Design only. Source inspected at Resize a41f78c2c; no implementation or compiler run.

## Concrete interface

Use the existing `Frozen<T>` within a resolver/process, not `Shared<T>`: executable bodies never mutate and recursive reads must not acquire exclusive runtime borrows. Frozen has allocation-free clone/get and permits nested reads. It is thread-confined; a future cross-thread body store needs Arc plus an explicit Send audit of interned types. Current fork workers retain process-local handles, never serialize pointers or TypeIds.

```
ExecutableBody {
  result, parameters, locals, blocks, externs,
  contexts, traps, cancels,
  features, inlining, optimizeSize, frame, lines, variables
}
LogicalMir {
  borrow, references,
  observes, suspension, parks, releasesPackages,
  nonParking, accesses, escapes
}
MirInstance {
  key: InstanceKey,
  logical: LogicalMir,
  body: Frozen<ExecutableBody>
}
MirDraft {
  key: InstanceKey,
  logical: LogicalMir,
  body: ExecutableBody
}
MirView<'a> {
  key: &'a InstanceKey,
  logical: &'a LogicalMir,
  body: &'a ExecutableBody
}
```

`MirDraft.view` and `MirInstance.view` return identical read-only interfaces. `freeze(draft)` moves payload once into Frozen. `instantiate(key, logical, body)` retains a new exact instance with a cloned handle, never changes a shared key. `thaw(instance)` explicitly copies only for a transformation that really mutates the body. No invisible body fallback and no shared representative key.

Keep source/proof `Origin`s exact in LogicalMir. Executable origins/debug can share only under the same declaration/source/profile/frame footprint already authenticated by the certificate. In particular, context labels, trap labels, cancellation blocks and hidden observing lanes are executable inputs, even though summaries also read them.

For the first implementation, sharing is restricted to certified Count/Resize bodies with no logical keys embedded in instructions. Ordinary bodies freeze uniquely. Flattened forwarding may share a leaf body while retaining exact forwarded references outside it. General cross-instance sharing of bodies containing `Callee.Instance`, function-address keys, or drop keys requires explicit body call-slot bindings; merely freezing those embedded first-instance keys is unsound.

## Producers and mutation boundary

| Consumer | Concrete migration |
| --- | --- |
| `Mir.silk` Builder, `lower`, `storageBuilder`, `storageHelper`, Count/Resize, cExport, generated helpers | Construct `MirDraft`; existing builders mutate `.body` and `.logical` explicitly. `Lowered` owns draft main+helpers until finalization. |
| `DropGlue.lower/lowerCore`, `UnionDispatch.lower` | Return drafts, retain exact own keys and exact glue/reference evidence. |
| `MirCoalesce.coalesce` and its private mutators | Accept mutable draft; local/block/debug rewrites cannot run on frozen payload. |
| `MirInline.call` | Mutable draft caller + read-only callee view; copy callee logical references into caller exactly as now. Never mutate the callee. |
| `Semantic.inlineKnown` near 80761 | Inline while caller remains a draft; held callees are views of completed instances. |
| `Semantic.storeMir/storeLowered` near 73784 | Coalesce, verify, compact, freeze once; append `MirInstance` to the resolver arena. Helpers follow same rule. |
| canonical lowerMir fast path near 81064 | Cache Frozen<ExecutableBody> by full footprint; every logical hit demands own evidence and creates only key+LogicalMir+Frozen.clone. Verification remains per-logical until its dependency behavior is explicitly factored. |
| `Semantic.releaseStaleMir` near 95320 | Drop instance/body handles; last handle frees payload. Replace emptyMir's dummy-empty payload with explicit `MirSlot{key,live:Option<MirInstance>}` (or separate slot identities/liveness), and make reads reject released slots. Templates count as real roots and must be evictable/reset, otherwise they pin old CFGs. |

Do not freeze before MirInline/MirCoalesce, and do not re-clone a frozen body merely to satisfy an old reader API. This refactor's performance benefit is specifically removal of repeated CFG copy/coalesce/compact.

## Read-only consumers and identity requirements

| Consumer | Reads from body | Must retain logical key/proof |
| --- | --- | --- |
| `InstanceRecipe.make` | Full instructions, types, externs, debug, policies | Own key and exact instruction call/drop/address bindings. Recipe currently begins with runtimeEncoding(key); retain that for logical content validity, then executable naming selects canonical footprint separately. |
| `InstanceText` / EmissionInputs | Recipe, layouts, C contracts, emitted body | `InstanceIdentity` still maps every exact logical key to executable name; borrow metadata remains per instance. |
| `LlvmCode`, `WasmLower` | CFG, params/locals, ABI lanes, debug and policies | Numerous owner-gap messages, export classification, own symbol lookup and glue-kind checks use key. Change these to `view.key`, never body representative identity. |
| `LoweringPlan` | ABI classification, placement and parameter types | Key controls owner diagnostics and export ABI. |
| `StackLifetimes` | CFG and locals | `fixedLinkage(key)` affects storage decisions. |
| `Coroutine` | CFG/cancel/local shapes | Variant facts and diagnostics retain exact key; frame specialization constructs a new draft/immutable body rather than editing an existing finalized body. |
| `MirVerification` and Semantic verifyLowered/callFlows | Instructions and local types | Semantic verification can demand layout/signature/drop evidence; preserve it for each logical answer unless explicitly replayed. |
| `MirText` | Instructions | Exact logical key must stay in dumps. |
| `Semantic` summaries, BuildCapture, escape/admission walks, replay, NonParking/local-shared proof | Some CFG facts plus logical evidence | All exact keys, provider-sensitive edges, spans, references, borrow status and summary obligations remain distinct. |
| `main.silk`, SemanticCaseSupport and compiler case modules | Debug/test inspection and copied fixtures | Update constructors and inspection APIs in same change; tests must be able to distinguish two logical keys sharing the same body handle. |

The production `MirFunction` users outside Semantic span 15 backend modules: Mir, Coroutine, DropGlue, ExecutableTemplate, InstanceRecipe, InstanceText, LlvmCode, LoweringPlan, MirCoalesce, MirInline, MirText, MirVerification, StackLifetimes, UnionDispatch, WasmLower. Main plus eight semantic case/support files also mention it. Remove ExecutableTemplate once shared-body instantiation replaces copying.

## Executable closure after full logical proof

Do NOT use BuildRecord.facts.callees: it captures direct-call summary positions, not the complete emitted edge set. `InstanceRecipe` scans actual `Terminator.Call(Callee.Instance)`, `Statement.Drop`, and `Rvalue.FunctionAddress`. Package start/glue, notifications and generated global/function-address initializers must retain their real roots/edges as well. Foreign symbols remain contracts; exported definitions, runtime startup/storage exports, address-taken/global initializers and explicitly retained artifact roots seed executable closure.

Use one pure, cheap `InstanceRecipe.targets(view)` visitor that shares target enumeration with `InstanceRecipe.make` but does not serialize all instruction bytes. Avoid computing a full encoded recipe for every proof-only node simply to discover targets. Require exact agreement between targets() and make().callees in a focused test covering calls, drops, function addresses and generated helpers.

Persist an explicitly known executable adjacency list per finalized body:

```
ExecutableEdges { targets: List<ContentHash> } // exact or definition mode matches record
BuildRecord.Entry.execution: Option<ExecutableEdges>
```

`None` means unavailable, not empty. Ordinary proof-only escape graphs may keep None. Aliases resolve to their proven representative; foreign leaves have known empty edges and contracts. A known target must resolve inside the complete admitted logical graph (or a validated foreign leaf); otherwise reject/recompute. Digests name exact selected keys/definition mode as existing record states, not a new interpretation of region aliases. Preserve packet provenance from selected key + MIR + outgoing executable edges. Canonical executable encodings can still alias multiple proved logical targets later at EmissionPlan.

A selector performs ordered root DFS over known executable edges, yielding logical entry indices; it changes neither logical graph traversal nor proof/budget counts. Preserve current root ordering and actual target ordering. Proof-only nodes still contribute source validity and errors. Never add all module-check definitions to executable roots.

## Serial path changes

`Semantic.buildFromTimed` near102454 currently demands EmissionInputs/LlvmText and collects text before summarizing/walking each node (102650 onward). Change to:

1. Demand exact MIR and collect logical summaries/references and executable adjacency in existing logical traversal/error order.
2. Complete NonParking, exports, local-shared, observer discovery and frame selection using the complete proof graph as today. A mode/frame restart invalidates the earlier execution selection and body handles for the old variant.
3. Select actual executable closure from final actual roots, then demand EmissionInputs/text only for selected entries; retain their existing request sites/order for diagnostics.
4. Assemble EmissionPlan from selected definitions while preserving the full logical proof cache graph.

Diagnostic semantics need a deliberate rule: currently backend unsupported/gap errors may arise while emitting proof-only bodies. First preserve preparation validation of every logical node and defer only text production; then explicitly decide/test whether backend-only unsupported code unreachable at runtime should remain a build error. Do not silently suppress an existing rejection while changing scheduling.

`rewalkBuild`, `replayBuild` and packet-backed cached builds must implement the same selection; a proof node without an emitted text entry becomes normal, not an incomplete record. `requestUnreached` NonParking obligations remain proof-only unless an actual executable edge/root also reaches them.

## Retained-worker and cache changes

- `artifactNode` near1317 publishes full proof refs plus targets(view) from exactly the selected completed MIR/variant. Never derive edges from a different region representative.
- Parent `retainedArtifact` near1770 keeps ArtifactGraph.merge/finiteClosed/budget/escapeFree over the complete proof graph. Replace batching every graph entry with batching selected execution indices. Workers command5 emit only those selected keys; speculative emission must not eagerly recreate all omitted definitions.
- DefinitionFragments existing full encoding/symbol/text/foreign-contract equality remains unchanged for emitted aliases. Packet context additionally authenticates executable adjacency/version; no process-local IDs cross IPC.
- BuildRecord codec and normalizedGraphEncoding include executable adjacency/knownness and version bump. Graph merge/fragment/rooted/adoption must preserve and compare it; checker-only records need not populate it. Do not reinterpret existing FACT_CALLEES.
- Cache BuildCapture stores full proof roots independently of emitted InstanceText roots/packs. Carry/replay maps cannot assume one text per body. Record dependency edges on every selected MIR and every proof root; a wrapper body edit that changes instruction reachability invalidates adjacency and reselection before reusing text.
- Same target/profile/observer/frame/compiler-policy guards as current executable specialization remain; update central compiler policy + record formats coherently.

## Minimal implementation sequence

1. Pure representation migration: draft/view/instance + unique frozen bodies, all readers/writers/tests updated, no sharing or closure pruning. Prove output parity and explicit released-slot handling.
2. Share certified Count/Resize payload only; delete deep-copy template helper. Require distinct exact keys sharing one Frozen allocation and no per-hit CFG copies/coalesce. Measure this separately before expansion.
3. Add executable adjacency capture/codec and selection in shadow mode; compare computed selected set with actual InstanceRecipe targets, including drops/address/package/foreign/export fixtures. Still emit old set during correctness development only, remove shadow path before final integration.
4. Enable post-proof selected emission in retained and serial/replay paths together; preserve diagnostics or intentionally update their specified behavior with tests.
5. Add acyclic forwarding certificate, then measured fixed-offset field projections for List.capacity. Preserve exact logical references while body loses calls. Reject descendant inlineNever/cold/features/optimizeSize initially; no spelling privilege.

No threefold gain is claimed from this design. The important expected win versus the failed Resize template experiment is genuinely sharing finalized payload and avoiding emission/preparation for proof-only callees, rather than expanding a small storage-helper wrapper into a large copied CFG per logical type.

## Generated-edge audit and initial conservative boundary

Concrete source findings:

- `Mir.lowerExecutionPackage` near7629 stores package drop glue, Start helper and Notify helper through explicit `Rvalue.FunctionAddress` assignments. These are executable edges even though SuspensionSummary excludes Start from its ordinary indirect-park propagation. Recipe target enumeration must keep all three; proof summary semantics are not executable liveness semantics.
- `Coroutine.Facts` contains `callees`, `inline`, and four C symbol byte strings `create/acquire/release/destroy`. `LlvmCode.emit` near5880 emits the ordinary driver plus `$enter` and `$step` in one fragment. Those suffix symbols belong to the selected instance's emission unit, not independently rooted InstanceKeys.
- `LlvmCode.emitSuspendingCall` near6894 starts with an exact MIR call key, resolves its executable name, then calls generated enter/step functions. Actual call targets remain necessary, but their matching frame variants must be selected before liveness selection; ordinary bodies cannot stand in for those variants.
- `Semantic.buildFrom` near102910 extends actual roots with all four selected execution-storage exports and binds their symbols in FrameSelection. Coroutine emitter uses those symbols through callNamed; an ordinary InstanceRecipe target list does not contain those calls. Preserve these extended roots explicitly.
- `LlvmCode` diagnostic/fatal/frame helpers and private string/constant globals are emitted into an owning fragment. Frame registry entries name that fragment's function/step; keep the whole fragment as the atomic emission unit. Do not prune individual generated globals/helpers by a logical-instance adjacency heuristic.
- `LlvmCode.staticValue` near967 builds private constant arrays and embedded text/static-view globals. The inspected path has no additional logical function-key edge, but future constant/function-address variants must be added to target enumeration before admission.
- `Semantic` selected named roots near102433 mark explicit retained roots; preserve these along with runtime startup, public/export shims, global/address initialization requirements, and final storage roots regardless of ordinary call reachability.

For an initial implementation, choose an explicit per-node `ExactExecutableEdges` versus `ConservativeLogicalEdges` result. Certify exact adjacency only for the audited ordinary final body shape; take the union of actual recipe targets and every proof reference for unknown generated/helper/suspendable/actual-observer bodies. Root selection is still complete. Do not advertise this as full closure minimization. The conservative choice must be serialized/authenticated and rerun if the body or backend mode changes.

Global observing ABI alone is NOT a reason to refuse pruning: startup always selects that ABI, including Count/Resize leaves that introduce no events. The narrow safe case may have hidden Observer/Cause/Site lanes and an authenticated frame while `observes=false`, no trap/context/cancellation metadata and no suspension variant. Actual observing scopes, nonempty context/trap state, coroutine facts, unknown package/notification machinery or non-audited emitter paths retain full proof adjacency until their extra edges are modeled.
