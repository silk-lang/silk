# Direct native-thread completed-body registry (unvalidated prototype)

Shared worktree: `.scratch/thread-frontier-prototype`, branch `codex/thread-frontier-prototype`.
Latest validated source checkpoint: `e9935553ca0cec8891e824176a63b42cacc8c810`.
Base: tested ownership/interner prototype `a5529b4c5`, V22 source ancestry; no CacheBundle or rejected body wire codec.

Owners: worker_forks owns Semantic + ThreadBodies; interning SourceEpoch/SourceIndex; parallel_semantics lifecycle/driver/aggregator.

## Representation and correctness boundary

`ThreadBodyRegistry` retains a fixed SourceEpoch, target, selected profile, application identity and SharedTypePool. Its preallocated ready-only directory matches complete DeclarationId + normalized profile category + ordinary Body identity. Misses never wait for an unfinished provider. Only explicit Semantic.threadWorker activates sharing; normal stores retain an empty registry and never clone shared bodies for this feature.

Each worker constructs its own Semantic/Query and ThreadTypes. Successful completed Body outcomes are published directly as Published<TypedBody> after outcome/location observation and Graph.finishRun. No capsule construction/decoding, raw post-fork pointers, or local query/declaration ordinals cross the registry. The TypedBody's exact checked Stage is retained unchanged.

Published immutable guard DAGs preserve ordered graph conjunctions. Source selector leaves replace private declaration handles with stable DeclarationId; receiving stores rebind them. Authored inputs are valid only inside the same retained immutable SourceEpoch. Request and package-resolution leaf digests are checked on first import. Later configuration/request changes detach sharing; lookup also requires the fixed application/target and supported profile category. Condition/origin/demand-path-sensitive nodes, opaque ModuleChecks, cycles and exceeded work/depth bounds refuse publication.

The receiver materializes each retained global guard identity once into private Graph units and normal SourceInputs. Imported Body units memoize the original guard rather than introducing copies. Paired import list/index publication reserves the list before publishing the index, so OOM cannot misassociate ordinals. Partial imports may retain independently valid guard nodes but publish no Body answer. Normal cache export traverses these guards, including fine callee header/name-roster inputs.

Limits: 65,536 directory slots, at most32,768 entries, conservative128MiB guard allocation charge and4,194,304 retained top-level body nodes, at most65,536 nodes/body. These are refusal policies, not measured aggregate process memory. Source/index/type payload sharing has independent lifetime/bounds.

## Lifecycle

ThreadFrontier owns join handles and one-command/one-response bounded channels. Each worker builds and keeps its mutable store on its own thread. Native-worker fields are separate from process workers. Success/error/abandon/None artifact completion joins native workers; SemanticCache saveTracked adds a final defensive join before any detached cache writer. The thread lane bypasses the early NativeCoordinator fork overlap until artifact proof/cache capture completes and all threads join. Existing process lane behavior is preserved.

No real compiler worker scheduler is enabled yet: this checkpoint tests the direct body/provider and lifetime seam first. Process pools are disabled in Semantic.threadWorker.

## Validation status

- First whole sourcecheck c848 failed syntax/name/reference migration errors; fixed by e6d7b2c58+b727bea82.
- Second whole sourcecheck84e4665ad failed only two duplicate local names in Semantic guard import/export; fixed4577884a1 (including analogous adjacent branch). No thread trait/lifecycle errors reported yet.
- Next full sourcecheck and actual native focused execution remain pending; no timing claims.
- One focused runner root `compiler/src/semantic/ThreadBodyCases.silk` imports all lifecycle/sourceepoch helpers. Added Semantic tests: `directThreadBodiesAvoidProvidersAndPreserveFineCacheGuards` and `directThreadBodyGuardsRefuseCyclesAndWrongRequests`.
- Actual test spawns a native producer with a private store, joins it, creates a separate consumer/store/provider, requires avoided Body providers and original guard identity reuse, then exports a cache and compares full ordered diagnostics after unchanged-caller/callee-header and name-roster edits against fresh serial stores. Separate guard test covers cycles, opaque checks, Condition ledger, and wrong request digest refusal.

## Prior approach disposition

Serialized512MiB process-body sharing is rejected:16-call matched screen `.scratch/benchmarks/shared-bodies-sequence-jzvt1quh` showed ~4.1% slower cold check/build and +2CPU build seconds despite6k+ provider avoidance and no exhaustion. Direct thread representation is a different experiment and requires its own measured benefit before promotion.

## Validated seam: e9935553c

Full sourcecheck PASS, and all10 focused native gates PASS (0cached), compiler/test/writer descendants reaped. DirectBody provider+callee signature/roster cache parity24ms; conservative guard test2ms. Other8 lifecycle, SourceEpoch, ownership/interner gates also pass. Parallel_semantics owns runner/receipts and released slot2. No full workload scheduler or performance claim yet.

The first focused attempt caught a real dependency omission: `Semantic.recording()` still used source mutability, so immutable SourceEpoch workers with Graph recording enabled omitted ordinary demandChild query edges. Fix e993 makes Graph.recording the authority consistently (including emission signature evidence). Ordinary cached/make constructors already have both recording capabilities; oneShot has neither; process ephemeral freezing disables Graph first and Source only on successful graph freeze. Thus existing lanes retain their modes. The regression now explicitly requires the imported caller guard to contain the callee module and retains exact fresh ordered diagnostics after both edits.

A separate fixture underflow came from observing a request outside any recording unit; corrected by starting/finishing a real Graph recorder before the observation. No production overflow was implicated. Earlier failed logs remain preserved.

Configuration scope: selectPackages/selectEditorTables/etc are the existing pre-demand configuration APIs. Detaching registry after a later mutation prevents new cross-store sharing, but does not promise ordinary Query.completed answers are invalidated or recomputed by those setup-only setters. The fixture asserts only that sharing detaches.

## Native scheduler activation candidate (2026-11-09)

- `536f542ca` adds the real fresh-store native lane; `1d9d68e90` fixes setup reconciliation effect declarations and adds bounded aggregate counters; final pending-native-gate source `cc953e8ff` moves assigned sweep filtering before incidental dependency encoding.
- Full sourcecheck at `1d9d68e90` passed; receipt `.scratch/thread-frontier-sourcecheck.json`, all compiler/writer processes reaped. `cc953e8ff` is being compiled by the focused native runner, not yet validated when this note was written.
- Four native workers construct private stores from one retained source epoch, exact frozen final command Setup and shared canonical type pool. Dynamic TaskQueue assigns each full module exactly once; index0 is runtime, not four duplicate runtime copies. Full 128-bit MIR claims use a bounded ready ownership directory, with saturation checking locally rather than omitting work.
- Direct body reuse stays completed-only. Each worker reports initial/final eligible, avoided, published, refused and MIR owned/skipped totals through gated frontier tracing. Initial and final snapshots must not be summed.
- Parent validates exactly one runtime record, no duplicate module sweep/coverage/record keys, each required module key, then the existing merged finite, callback escape and global resource-budget proof. Native command2 closure completion and retained commands3–7 use the same existing proof/cache/emission implementations via owned byte transport.
- CLI-only explicit flag `SILK_EXPERIMENT_THREADS`; normal capacity admission before shared setup and immediately before spawn. One-core rejection keeps the ordinary TypeTable/source store. Process lane remains separate. No native worker forks; early native coordinator overlap is bypassed while semantic threads live. Export/join precedes detached cache writers/native forks.
- Focused native activation test added: actual four fresh private stores, two modules, exact one-runtime/two-unit coverage; invalid callee refuses and all workers join. Existing direct-body/cache dependency fixture now uses Some(application), matching CLI context.
- No native whole-program engagement or speed measurement yet. Complete-runtime single-task tail is intentional first-stage scope; seed-based donation can follow measured evidence. Serialized body codec remains rejected.

## V1 engagement diagnosis and V2 freeze

- V1 optimized compiler (`a2ad27...`, source `f595e23f1`) built the first real native fixture correctly but did not start a pool. Preserved cohort `.scratch/benchmarks/thread-frontier-native-t9cp7qxs`.
- The concrete cause was the build-only preliminary check gate still requiring the process flag. `f4a8b66b4` admits either process or native permission there. No profile/assembly guard was relaxed.
- Independent old-V1 fresh check (normal admission) did accept all four native stores: `.scratch/benchmarks/thread-frontier-check-iggqzjyo`. This isolates the missed build gate from registry attachment.
- `9901bbaa4` defers registry and Setup allocation until actual admitted cold launch. Warm/tiny commands retain no ready directory and cannot publish shared Body guards. Added behavioral cache→callee body edit→real Body miss fixture, checking zero sharing bookkeeping before launch.
- `38607d988` adds a fixed nonallocating `frontier threads joined` marker after explicit close/join and clearing a nonempty native worker list. It covers retained stop and local launch/failure cleanup; empty stores emit nothing.
- Full sourcecheck `38607d988` passed (86.7s, reaped). Native14 focused gate is pending at this note. No timing claim; V1 remains preserved unchanged.
