# Direct-thread sharing component checkpoint

Source: `e9935553ca0cec8891e824176a63b42cacc8c810`, clean worktree `.scratch/thread-frontier-prototype`.

Full compiler sourcecheck passed with pinned CI N1 and matching modified stdlib. Receipt: `thread-frontier-sourcecheck-e9935553c.json` and matching log.

Ten native tests passed, all executed with zero test-result cache, one unoptimized runner. Receipt: `thread-frontier-e9935553c-focused.json`; seven exact-filter logs and runner retained. All compiler/test descendants and writers reaped; shared slot released.

The real native producer publishes a completed immutable TypedBody; a separate private consumer avoids its Body provider, preserves original guard identity, exports cache evidence and reproduces full ordered fresh diagnostics after changing a callee signature or declaration roster while caller text is unchanged. Direct reuse test 24ms; guard rejection test 2ms. Remaining tests cover persistent command/reply lifecycle, early worker exit, immutable source epoch/native syntax sharing, transitive body ownership, runtime snapshots, concurrent interner publication and private canonical memos.

The first native run caught a genuine recording mismatch: immutable SourceEpoch disabled SourceIndex revision support, while the thread constructor enabled its Graph; old Semantic.recording used source revisability and omitted ordinary query edges. The fix makes Graph.recording authoritative for semantic dependency/cache evidence. The stronger test explicitly requires the caller guard to retain callee source evidence. The malformed-request test now observes inside an actual Graph recorder, avoiding a test-only empty-list underflow.

No scheduler activation, optimized compiler bootstrap, throughput claim, or CPU0 performance claim. Parent pool is still empty; lifecycle/fork barriers are staged. First full thread scheduler must finish artifact/cache proof and join before NativeCoordinator continuing fork; saveTracked and explicit store-abandon paths also join. Existing process lane remains unchanged. Actual multiworker command execution, failure fallback and all native/cache fork lifecycle paths require subsequent end-to-end gates before promotion.
