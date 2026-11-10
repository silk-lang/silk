# Function-count reduction audit (V22 source, existing V15 census)

No production change or new compiler/LLVM workload was run. Existing duplicate JSON extraction after exclusive release took32ms. Inputs and extracted counts are in generated-function-sharing-envelope.json.

## Measured envelope

The whole exact-code duplicate pool is10,879 redundant definitions out of43,126 (25.2%), but386,717 instructions (8.41%) and7.27% normalized bytes. Most duplicates retain distinct authored debug identities. The subset with no recorded debug subprogram, no observed address use, and no module-local normalization restriction is961 definitions (2.23%),31,351instructions(.68%). It is an opportunity screen, not an equivalence proof. In particular, llvm-dis discarded malformed debug in one original module, so absence of a parsed subprogram cannot authorize code sharing.

One660-member group comprises43 instructions each and calls guarded_reclaim/free:659 redundant definitions/28,337 instructions. Source strongly suggests generated allocation/raw-buffer cleanup. All duplicate groups with<=3instructions have debug subprograms; there is no measured giant no-debug empty-drop pool.

## Existing elimination

V22 Semantic.cleanupNeeds (~78453) applies sharedCleanupFree after concrete substitution for every local/node. Semantic.glueNeeds (~74002) and glueChildren omit cleanup-free children. InstanceKey.dropGlue (~421) conservatively establishes a possible cleanup owner, while actual MIR construction uses the exact cleanup proof. Removing nominal cleanup blindly at identity construction would bypass required semantic/layout/read evidence.

## Concrete count-saving architecture

For generated, non-address-observed cleanup only, canonicalize the finalized cleanup recipe rather than emit an extra wrapper. Semantic.resolveCoreGlue (~74761) currently gives RawBuffer<T> its own InstanceKey even though DropGlue.lowerCore Allocation (~262) only reads reclaim/context fields and performs the same free/guarded-reclaim operations. A backend recipe identity would include target pointer ABI, concrete field offsets, observer mode/hidden ABI, external free/reclaim contracts, and every child/hook recipe. Direct references must name this canonical identity, so obsolete type-specific functions are never sent to Bitcode/Clang. Keep original exact semantic queries, invalidation leaves, budget/proof entries and per-instance checking; this is backend sharing only.

Requires proof that functions have no externally observable addresses, exports, package vtable references or authored debug variables/source scopes; address-bearing variants retain distinct identities. Compare complete normalized recipe bytes on hash collisions. Canonical choices must be scheduling-independent. Recursively merging wrappers can use child recipe identities, but cycles require explicit SCC handling. Generated origin and empty variables/lines in DropGlue.lower/lowerCore offer a stronger debug premise than the census null marker.

## Recommendation

Do not prioritize this narrow implementation as the route to3x: its currently evidenced definition/instruction envelope cannot support a multi-CPU-second prediction. Broad layout-equivalent generic sharing has a much larger function-count envelope, but layout alone ignores callees, constants, hidden provider/observer ABI and authored debug types/scopes. Sharing debug-bearing bodies without wrappers requires a deliberate debug representation/alias strategy; it is not established by LLVM code equality. Late linker ICF saves no parsing or native function-pass work.

Use V24 native profiles to first measure fixed per-function pass/debug cost. If a substantial fixed component is confirmed, quantify the debug-congruent subset and compiler-private address contract before undertaking general body-identity remapping. Otherwise continue the larger semantic/cache costs rather than adding small generated helpers or lowering debug defaults.
