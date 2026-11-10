# Finite policy platform and cleanup validation

Worktree: `.scratch/finite-platform-cleanup`, branch `codex/finite-platform-cleanup`, base `2e0c210b2`.

Commits delivered to root:

- `6ad2834ac`: Linux-specific fork/socket/mmap adapter; compile-safe serial fallback on other hosts.
- `0fe80d66d`: obsolete ancestry RPC command1, independent fork-check path, portable fragment family/runtime/witness metadata and tests removed. BuildRecord format11.
- `9fbcdb646`: unused Specialization family/descent/field evidence removed; severs Specialization's direct Semantic dependency.
- `0b8fef2d6`: graceful mmap/tmpfile/socketpair/fork setup failure, partial-child teardown, null-safe centralized stream close, EINTR-safe wait.
- `22044f3d0`: dead Decision/cleanup/owned-descent branches removed; replay requires closed canonical inputs and exact visited graph instead of ancestry. Retains all source, callback, NonParking and resource checks. Alias facts retain CLOSED/KEY_BYTES; record format12. Moves mapping allocation after fallible list setup.

Validation:

- Host adapter sourcechecks pass for x86_64 GNU Linux, aarch64 macOS, x86_64 Windows. Repeated after EINTR wrapper change. Log `.scratch/finite-host-platforms.log`.
- Complete source compilation and focused frontier suite pass **5/5** after Decision/replay cleanup: exact finite budgets, deep400 identity Resource limit, complete graph extension, callback/escape obligations, remap/cycles and final-callee codec. Log `.scratch/finite-cleanup-helpers.log`.
- Initial helper link attempt lacked SILK_CLANG; corrected to `.scratch/llvm-22.1.8/bin/clang`. This was environment configuration, not a source failure.

Pending working-tree cleanup removes the remaining replay path hashes, fake Leave visits, saved cleanup ancestry and unused edge copies. It preserves structural parent-position checks, actual recorded MIR edge digests, callback scheduling and key reconstruction. Pending CacheAdoptCases compilation/runtime suite after profiling's reserved warm benchmark window.

Failure injection artifacts (outside repository):

- `.scratch/frontier-host-failures.c/.so`: fails selected shared mmap, tmpfile, socketpair, fork call; can inject EINTR for waitpid. Logs INJECTED marker.
- `.scratch/frontier-host-failure-project`:40modules/600leaf functions, enough to exercise the frontier.
- `.scratch/test-frontier-host-failures.py`: serial baseline, accepted parallel baseline, first/partial pool failures, interrupted wait. Uses benchmark subreaper helper to settle all descendants. Run under shared performance lock after reserved benchmarks.
- Root-selected frozen binary `.scratch/frontier-integrated-first` SHA9b5b5f370b0f716601ccc1d668700108484e9ee36aefa6ce01259cfa911e8c04 includes platform/fallback/ephemeral/dynamic, predates Decision cleanup.

Root also requests current integration `SemanticLoweringCases::instanceKeysCanonicallyNumberCompleteCallerRegionGraphs`, including updated NotProven/SpecializationBudget exact-header expectation and400-reference stack regression.

All compiler/test jobs use shared `.scratch/performance.lock`; benchmarks use exclusive. Max2heavy jobs. Root's current integration preserves mapped size4194320, timing wrappers, immutable-store gate and explicit CLI worker permission. Do not overwrite these with older baseline code when merging.

Runtime allocation follow-up is authorized after cache validation. Script `.scratch/remove-runtime-admission.py` is prepared but not applied: borrow canonical Application for closedness, remove Admission.active copies and synthetic BackendVisit.Leave scheduling in capturedEscapes/buildFrom, preserve authored request origins and cleanup fields. worker_forks explicitly approved removing Leave and will adapt partition tests; dynamic inheritedRemaining must still count actual pending Enter positions.

## Continued validation and cache repair

- `3c13e109d` delivered the remaining replay bookkeeping cleanup. Source compiled. Original CacheAdoptCases result:30/34 passed; all changed-body replay cases pass. Four unchanged/reporting hit-count assertions fail on both cleanup branch and root integration baseline (`finite-integration-cache-before*.log`), proving the finite-budget memo regression predates that cleanup.
- Current integration caller-region canonicalization test passes34ms, including400-reference stack bound and root's exact-header Resource diagnostic (`finite-integration-region-tests.log`).
- Host failure injection matrix passes10/10, all descendants reaped: serial/accepted parallel, mmap failure, first/partial tmpfile/socketpair/fork failure, EINTR retry (`frontier-host-failure-results/results.json`).
- Staged green-hit fix attaches exact validated persisted budget record indexes during adoption, imports their graph cost without semantic queries, and reuses verified hard diagnostic memos. Worker assigned captures remain mandatory. All original34 cache cases now pass (`finite-cleanup-cache-fixed.log` first completed run).
- Added changed-body finite-budget diagnostic regression fails before transactional fix: both cold/warm report exactly one SpecializationBudget, but authored spans differ. Stale replay spent sticky global budget before falling back.
- Current staged follow-up adds nested Budget mutation journals/checkpoints around speculative check/build replay and atomic record imports; successful paths commit without copying the graph, failure rolls back maxima/new definitions/body counts and exhaustion before authoritative live diagnostics. Added nested-journal assertions and unchanged-adopted graph under a tighter budget (including retry under relaxed budget). Validation pending root CPU schedule.

### Completed cache and runtime follow-up

- `8712e5b6a`: verified green escape memo budget attachment, hard-error reuse excluding resource diagnostics, nested speculative budget journals, transactional record import, and cold/warm resource code/span regressions. Full CacheAdoptCases compilation/runtime suite **36/36 PASS**,472ms (`finite-cleanup-cache-fixed.log`). All4 previously failing hit-count tests now pass. Exact span parity now holds for changed-body growth and unchanged cache under tighter current limits; a relaxed subsequent budget does not reuse the previous resource refusal.
- `3271802cb`: runtime check/build and keyFacts borrow canonical Applications for closedness, remove unused Admission application copies/active stacks and BackendVisit.Leave tasks/origin placeholders. StaticClosure retains its diagnostic ancestry; authored request origins, cleanup/requester fields and exact graph budgets remain. Full CacheAdoptCases/build/finite helper suite **36/36 PASS**,605ms (`finite-runtime-no-ancestry-tests.log`).
- Root integration must add `budgetRecord:usize.MAX` to interning's2 new EscapeMemo test constructors, preserve dynamic mapped size4194320/gates/timing wrappers, and adapt private-fork selector/test to Enter-only queues while keeping inheritedRemaining positional boundaries. worker_forks notified.
- All own compiler processes settled; shared slot released to build_pipeline. No further heavy tests queued.
