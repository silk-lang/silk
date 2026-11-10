Cold checking and building repeatedly traverse the same specialization graph and regenerate backend state. This draft replaces ancestor-based generic recursion rejection with a bounded, complete finite-graph proof, distributes runtime and declaration work across processes, and retains checked worker state for artifact discovery and emission. Proven finite type permutations now compile; unbounded growth receives an authored resource-limit diagnostic.

The implementation includes exact declaration-range coverage, global callback/escape and resource accounting, descendant routing, deterministic lifetime-erased code identity, rollback-safe cache replay, and cleanup on worker failures. Debug metadata interning and direct source-marker scanning remove duplicate backend work. Cache input/path fixes preserve authored files under cache directories and native header symlink semantics.

Validation: exact head `31a7a6dd30f125ddfe498514c8fd864c67534e35` passed Focused Linux Silk and the remaining Selfhost jobs (run 42525121741), including native platform suites. Local checks cover cache replay, allocation failures, finite/infinite recursion, host failures, descendant emission, and serial/parallel artifact equivalence.

Measured cold performance for the integrated `5067882de` candidate against the original frozen baseline, two reversed trials with empty compiler caches:

| Workload | Check baseline → candidate | Build baseline → candidate |
| --- | --- | --- |
| Compiler | 22.387s → 8.471s (2.64×) | 37.830s → 16.284s (2.32×) |
| Harfrust | 7.618s → 2.507s (3.04×) | 11.636s → 4.518s (2.58×) |

These cold gains do not establish the overall 3× goal. The candidate has substantial first-edit and later-edit regressions because worker results do not yet populate all ordinary incremental dependencies. This blocks default activation. Follow-up implementation and measurement are in progress; the acceptance matrix compares cold, unchanged, direct cold→first edit, and subsequent edits separately for both operations, including background-writer settlement. An unchanged run must not prime the direct first-edit case.

This remains a draft. Complete incremental persistence, the selected worker policy, and removal of experimental controls/tracing are required before promotion.

Publication status: updating the PR with this description was rejected by automatic approval review as external disclosure beyond the coding authorization. This local proposal has not been published.
