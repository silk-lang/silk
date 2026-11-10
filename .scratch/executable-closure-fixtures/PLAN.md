# Executable closure native/cache gate

Use one manifest cache and fresh processes; four-unit pinned candidate, O0/full-debug and O2.
The generic `ignore` imposes NonParking on a callable but never invokes it. The logical proof
must include `operations.proofOnly`; executable selection should omit its native definition
provided lowering does not actually materialize its address. Assert this from emitted/DWARF
identity and selection traces, not from timing.

1. Closure OFF cold: runtime42, proofOnly present. Closure ON cold: runtime42, proofOnly omitted.
2. Same-cache caller edit ignore→invoke: runtime9; previously green proof-only entry must now emit.
3. Caller restore ignore: runtime42; then unchanged must do zero build work.
4. While ignored, reorder Pair's fields without changing named constructor/body; then invoke:
   runtime9 (old offsets would read7). Compare a fresh serial candidate and exact diagnostics.
5. Replace proofOnly with a source-valid native-unsupported Wasm memory intrinsic. Ignored ON
   succeeds42; called ON rejects with the backend intrinsic gap. OFF still rejects even ignored.
   This explicitly documents the MODULE-004 backend-only diagnostic boundary.
6. Make the ignored proofOnly body source-invalid (`return "wrong"`): ON still rejects with
   exact fresh-serial source diagnostics. Restore valid body and require recovery.
7. ON→OFF→ON policy flips: exact representation/count expectations and same-ON artifact restore,
   not merely runtime42. Exercise declaration/body/layout first and later edits directly.
8. Retained/full-original artifact engagement separately requires actual pool admission; no host
   override. Existing observer/provider/coroutine and callback/function-address fixtures remain
   mandatory to cover conservative generated roots and actual executable addresses.

No fixtures have been compiled yet. If the ignore source still creates a real function address,
retain that body and adapt the proof-only fixture using the existing nonParkingBuild cases; do
not weaken executable-address traversal to force the test to pass.
