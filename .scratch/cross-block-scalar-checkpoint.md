# Cross-block scalar SSA prototype

Source worktree: `/workspace/silk-cross-block-scalar-ssa`, branch `codex/cross-block-scalar-ssa`.
Base: V16 `cbb2fe84f2751f8fce9b9c38d25902dbcaee6969`.

Dependency order:

1. `91eff5f1a` — single-definition scalar Temp proof expanded using actual CFG immediate dominators. Unreachable mentions, repeated writes, partial/address uses, named/debug values remain excluded. A definition must also precede the consumer in numeric MIR emission order; arbitrary LLVM forward values are not introduced. CHK reverse postorder handles cycles/irreducible entries. No-candidate and one-block fast paths limit overhead.
2. `8e0d02268` — direct infallible scalar call results use their existing returned LLVM value instead of store/load. Only ordinary direct non-fixed caller/callee without provider/diagnostic/failure convention. Whole destination only; actual scalar layout still checked by emitter. Aggregate/vector/unit/out-address/native/indirect/fallible conventions retain storage. Optional destination Address is absent for promoted results and guarded against any ABI address lane. Terminator-local argument reads of the destination reject promotion.
3. `fdc3b2d8aadd75268075f4395446c9a64410b03f` — permanent `corpus/native/scalar-call-result-values` regression: chained bool/i8/i32/f64/pointer values, aggregate control, addressable local and loop; expected42.

Validation:

- Full package sourcecheck using pinned N1: PASS25.98s, settled writer exit0. `.scratch/frontier-cross-block-scalar-sourcecheck.log` and JSON.
- Focused scalar SemanticLoweringCases runner: **10/10 PASS**,155ms test time. `.scratch/cross-block-scalar-focused.log`. Includes12 CFG topology scenarios and8 ordinary/foreign/indirect/failure/provider/diagnostic/read-before-result cases, plus previous numeric/projected/scalar tests.
- Root and worker_forks independently reviewed dominance and direct-return ABI path; no identified blocker.
- No standalone optimized candidate built. Actual native/debug/corpus gates using the new compiler and exact emitted load/store census remain REQUIRED before performance claims.
- Shared slot released to interning after both validations; all descendants reaped.

Construction helper prepared if needed: `.scratch/bootstrap-cross-block-scalar.py`, package `.scratch/cross-block-scalar-package`. Four-unit O2 correctness construction only; not construction-quality comparable to V16 mono-PGO. Root plans combined next candidate instead.

Risks to measure:

- Dominance adds work to every multiblock function with surviving value candidates, including candidates later rejected for aggregate layout or all-same-block uses. Profile cost before adding a demand-only CFG optimization.
- The old401k scalar-slot estimate is only a broad IR upper bound, NOT proven eligible. Earlier direct-call-result census40,062 is also not a MIR proof. Exact new load/store reduction must be measured.
- Numeric emission-order restriction deliberately leaves some valid CFG values in memory. No block layout/debug metadata reordering in this prototype.
- One-core cold/edit behavior remains an explicit measurement gate.
