# Exact internal-body sharing investigation

Prepared script: `.scratch/llvm-promotion-experiment/census-duplicate-bodies.py`.
No compiler or LLVM process has run for this investigation. Eight synthetic normalization/constraint checks passed, including preserving constant strings and semantic module flags.

Scheduled command (only after an explicitly granted shared slot):

```sh
flock -s /workspace/silk/.scratch/performance.lock python3 /workspace/silk/.scratch/llvm-promotion-experiment/census-duplicate-bodies.py /workspace/silk/.scratch/benchmarks/backend-storage-v15-compiler-capture/capture /workspace/silk/.scratch/backend-storage-v15-duplicate-bodies.json
```

The script streams each retained bitcode pack once through llvm-dis. It keeps a hash and counts per function, plus one pack's metadata/attribute tables; it never retains full LLVM text or complete function bodies. Output includes exact duplicate groups, redundant definition counts, instruction and normalized-byte shares, static direct-call counts, and a separate no-observed-address subset. Repeated copies of the same symbol across packs are excluded from redundant-specialization counts.

Normalization is deliberately narrow:

- Replace only the complete own function symbol, including direct self-recursion. Do not rename SSA values, other callees, referenced constants or own-qualified private constants.
- Remove debug records/intrinsics and debug-only attachments. Preserve literal strings, ABI signatures, attributes, arithmetic flags, constants, control flow and non-debug metadata.
- Resolve attribute-group IDs to their complete contents and preserve target triple/data layout and semantic module flags. Debug encoding flags can be ignored with the debug metadata.
- Named types, private/unnamed globals, unresolved semantic metadata or flags restrict a match to its original pack. This creates false negatives rather than unsafe cross-module matches.
- Scan all captured LLVM symbol uses separately: any executable use other than a direct call is address-observed, including stored/passed pointers, aliases, blockaddress and llvm.used. External native objects, module assembly, dynamic lookup and foreign contracts remain unproven.

Code-identical is not synonymous with shareable. Generated `silk_<digest>` definitions generally have LLVM external linkage (`LlvmCode.emit`, currently line5784), even though their language identity is internal. The hash-shaped naming heuristic is not proof that a user C export or native object cannot refer to a symbol. Every candidate keeps its linkage/address classification. Full source debug variable/type/scope identities are explicitly unverified; ignoring debug metadata only measures code opportunity.

## Upstream source assessment

`InstanceKey` deliberately retains declaration identity, concrete generic/static/provider inputs and exact semantic validity. Its code encoding erases caller lifetime validity, but not arbitrary concrete type arguments. `InstanceIdentity.make/name` then supplies deterministic body-independent symbols to definitions and every direct reference. Those semantic identities must remain separate even if emitted bodies happen to match.

Plausible exact-duplicate families include generic layout-independent accessors (`List<T>.length/capacity`, slice or map counts) and empty drop helpers. Their ABI and actual loads can coincide for many T values. This is only a hypothesis pending the census; many such functions are tiny, so function counts alone can exaggerate their compile-time importance. Calls to type-specific helpers remain different in this first census, intentionally excluding coinductive call-graph folding.

`LlvmCode.privateConstant` names each constant with its owning symbol. Source-specific trap/diagnostic strings, addresses and constants therefore remain different. They must not be erased to inflate an equivalence class. Coroutine enter/step addresses, callback adapters and drop function pointers are commonly address-observed and need separate identity treatment.

A sound production design, if the measured instruction/byte share warrants one, would share code only after semantic validity and concrete lowering inputs are established. Do not weaken InstanceKey or semantic query identities globally. A late per-emission canonical code identity could deduplicate before Clang, but must preserve every referenced symbol/constant and require proven debug congruence or a debug-preserving representation; simple aliases/tail thunks do not automatically preserve stepping, source types or function addresses. Canonical selection must be deterministic across discovery order and worker schedules. Link-time ICF is useful as a size experiment but cannot recover LLVM IR parsing/code-generation work already performed.

Next decision: run the bounded census, rank groups by redundant instructions/bytes (not count), inspect representative exact bodies and source/debug families, then decide whether any substantial subset has a clean code-sharing proof. No production merging is implemented or proposed for promotion yet.
