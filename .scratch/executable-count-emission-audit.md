# Executable Count emission-path audit

Read-only source audit of `.scratch/executable-specialization` after initial native fixture produced preliminary certification but zero canonical text and no opaque debug view.

## Cause

No separate production direct-file LLVM emission path bypasses executable naming. `LlvmCode.emit` has one production call, `Semantic.emitInstance`, reached through `resolveLlvmText`; the other call is test support. `resolver.direct` means direct Wasm, not a direct-file CLI build. Both own and callee executable symbol substitution occur in `resolveEmissionInputs`.

Normal native startup reaches `NativeDiagnostics.observe` (`stdlib/silk/platform/native/start.silk` observedApplication and startup wrapper). `buildFrom` deliberately discards its initial ordinary walk and restarts every definition with observing=true. `executableCountEncoding` refuses observing both during MIR lowering and emission identity construction. Consequently preliminary check/walk certification is not evidence that the final artifact used canonical Count. Switching allocation out of the test cannot remove this startup policy.

## Safe extension requirements sent to owner

- Preserve the observed ABI: append ordinary Observer, Cause, Site locals using existing MIR types, after the written parameter. LoweringPlan derives definition lanes from these locals; callers already pass diagnostic operands. Merely removing the observing gate would create an ABI mismatch.
- Use existing `reportRoot` and `siteText` to retain request dependency and logical frame identity. Frame names depend on declaration/report root, not erased element type.
- Include observing mode in the executable key and classification memo identity. Current classifier hardcodes false and memo stores encoded bytes using declaration/application/profile only.
- The certified Count leaf has only header load and Return: no calls, traps, failure, or observer events. Diagnostic arguments can remain unused. Non-effect signature validation already prohibits a declared failure channel.
- Keep original authored origins and opaque header variable view; hidden locals should follow ordinary source-variable filtering.
- Preserve Wasm, revisable, provider, static, condition/origin and unsupported suspension exclusions. Global observing affects ordinary package and direct-file native builds alike; support must work on normal startup without a fixture-only policy toggle.

Required validation: final canonical text emitted/reused counters, shared symbol/caller ABI consistency, runtime parity, observer-sensitive negative cases, opaque DWARF verification, and ordinary package/retained build paths.
