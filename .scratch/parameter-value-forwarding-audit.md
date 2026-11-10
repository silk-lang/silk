# Parameter value forwarding prototype

Source: /workspace/silk-parameter-value-forwarding, based on V18 2d2d0e5.
Status: source draft only; no compiler or native validation yet.

## Proof and lowering

The existing full MIR effects pass now accumulates a separate immutable-own-slot proof for written parameters. Any whole write, own-address exposure, or Drop rejects the parameter, including unreachable blocks. A projection beginning with Deref affects pointee storage rather than the parameter slot. Other projected writes/exposures conservatively reject. The full pass is necessary before forwarding, so an address exposed after an earlier read still excludes all reads.

LLVM forwarding is restricted to ordinary non-fixed/non-C-export direct scalar ABI lanes. Unit, aggregate, split/coerced/indirect, vector, and coroutine storage remains unchanged. Every named slot, entry store, variable identity, and DWARF location remains. No source-local renumbering or debug metadata changes occur.

Only plain scalar reads and the first pointer-load step from a parameter slot reuse the original incoming Value. A later pointer dereference always emits a memory load, so pointer-to-pointer mutation is observed. Foreign arguments use values for direct lanes; indirect foreign arguments copy into caller-owned temporary storage before calling, so implicit foreign ABI handling does not expose eligible scalar parameter spill addresses. Explicit Ref/AddressOf/ContextOf exposure rejects the slot.

## Debug contract

Repository searches of reference/, .github/CI.md, backend debug comments, and corpus coverage found requirements to preserve variable values, locations, scopes, and addressable named storage, but no explicit guarantee that manually changing an otherwise unexposed parameter spill with a debugger changes program execution. This prototype preserves the declared slot and its actual program value throughout the variable's lifetime because program writes/address exposure reject it. However, an external debugger that writes that private spill after entry may display a new value while later execution uses the original argument. That is a concrete limitation for review, not a reason to infer a new authorization requirement. Program-visible pointer mutation and all address-exposed parameter edits must remain exact.

## Evidence and expected scope

Profiling's V17 LLVM census finds 75,195 direct-argument scalar spill slots with 210,319 associated loads, 21.2% of remaining compiler loads. It requires one argument store and only loads/debug declarations, and is a conservative LLVM-shape count, not a proof that this MIR analysis selects every slot. It excludes transparent bool/subword casts and does not count pointer slots with some additional uses. No runtime or build speed projection is justified yet.

Focused tests must prove own write, own address/call clobber, unreachable mutation refusal, and pointer-pointee write/address acceptance. Native fixture covers bool, narrow integer, floating, mutable parameter, exposed own scalar/pointer slot, pointee mutation, second dereference mutation, and aggregate control. Compare actual emitted loads and native runtime at optimization none, with and without debug. Verify DWARF named variable/type/source identities and location coverage against V18; unchanged slots alone do not prove whole debug behavior.

## Mapping the 210,319 LLVM loads to this MIR proof

Expected common overlap is scalar Parameter locals read directly, or pointer/reference Parameter locals whose only mutation is through their pointees. Existing lowering emits one named entry spill for these; the proof supplies the original ordinary LLVM argument without alias or dominance analysis because it dominates the entire ordinary function. Numeric readers use the forwarded value too, instead of their previous address/type-check load path.

The census is neither a lower nor an exact upper bound for the implementation. It includes some external/coerced function arguments that this draft refuses and does not establish MIR Parameter identity. It may omit pointer parameters whose pointee address is computed/passed (this draft can safely forward the pointer slot's first load), and transparent scalar casts. The draft rejects any own-address observation, whole write, or own Drop, including in unreachable MIR; some LLVM spills may have lost those uses before the census. Loads bypassing loadPlace/emitNumeric remain as-is, e.g. C variadic promotion and typed address/integer conversion, so there is intentionally no claim that every syntactically eligible slot load disappears.

The next comparison must count actual before/after alloca/load/store totals, not infer a speedup from the spill count. Slot/store counts should remain unchanged for this parameter-only change. Correctness does not require a precise count, and no instruction-count assertion belongs in the semantic fixture.

## Validated checkpoint

Clean final source: 0dd43d601590154008a7fb8c8fe77d8eaff407dc.
Commits in order: fc8fde9e3, 9cb2f288e, 0dd43d601.
Pinned-N1 full compiler sourcecheck passed (24.58 s; five existing unused imports only). Two focused own-slot/IR and direct-bool representation tests passed in 7 ms, after correcting the fixture's expected boolean memory load from i1 to existing i8+trunc. The bool case confirms branch/negation/return use i1, while the retained entry spill stores a widened byte. Standalone native fixture sourcecheck passed; shared-reference own-slot mutation syntax was replaced by raw pointer own-slot exposure and a mutable record containing the reference for true later-dereference mutation. No production changes were needed after initial checkpoint.

Logs: .scratch/parameter-value-sourcecheck.log, .scratch/parameter-value-focused-final.log, .scratch/parameter-value-native-fixture-sourcecheck-retry.log. Initial failed fixture logs remain preserved. All compiler descendants reaped; shared slot1 released. Actual native O0/debug, DWARF, cache-edit validation and emitted census await the combined V20 diagnostic compiler. No measured speed claim.
