# Native assembly and entry fragments

This contract exposes the machine boundary needed by selected Linux and Darwin ARM64 source.
Syscall numbers, wrappers, OS error handling, stack decoding and startup composition remain
ordinary library code.

## ASSEMBLY-001 — Typed literal assembly contract

**Status:** Candidate.

**Rule:** `Intrinsic.assembly<Result>(template, constraints, clobbers, memory, sideEffects,
noReturn, inputs)` is unsafe. The first four arguments are literal strings; the next two are literal
booleans; the last is a tuple of zero through seven runtime operands. Metadata is consumed by the
compiler. The result is unit or one `i64`, `u64`, `isize`, `usize` or data-pointer value. Each operand
is one of those non-unit lanes. Linux x86-64, Linux ARM64 and Darwin ARM64 are admitted targets.

**Example:**

```silk
unsafe fn add(left: u64, right: u64) -> u64 {
  return unsafe Intrinsic.assembly<u64>(
    "addq $2, $0", "={rax},0,{rdi}", "flags", "none", false, false, (left, right))
}
```

This x86-64 fragment ties `left` to the output and takes `right` in rdi. Selected ARM64 source uses
its own template and registers. Wrappers may hide literal metadata behind ordinary typed functions.

**Boundary:** Static execution, Wasm, floats/vectors, aggregate lanes, references and narrower/wider
integers are unsupported. Metadata must be literal at the intrinsic use; a runtime string or tuple
cannot become assembly metadata. LTO is not admitted.

**Diagnostics:** Invalid metadata, lanes and targets diagnose at the call and offending source
arguments before machine execution.

**Evidence:** JUL-135; LLVM 22.1.8; `native-assembly-entry-contracts` OpenSpec.

## ASSEMBLY-002 — Constraints and machine effects are explicit

**Status:** Candidate.

**Rule:** A non-unit result has one `={register}` or early-clobber `=&{register}` output. Each input
has one fixed `{register}` constraint or one `0` tie to the output. Tied lanes have compatible LLVM
kinds. Fixed input/output overlap must be spelled as a tie. x86-64 admits rax/rdi/rsi/rdx/rcx and
r8–r11; Linux and Darwin ARM64 admit x0–x17. A comma-separated clobber string admits those registers
plus `flags` (lowered to LLVM `cc` on both ARM64 targets). Darwin's reserved x18, callee-saved
registers, frame pointer, link register and stack pointer are not operand/clobber registers.
Duplicate or conflicting registers, unknown constraints and multiple results are errors.

`memory` is `none`, `read`, `write` or `readwrite`. `sideEffects` declares observable effects beyond
the output. `noReturn = true` requires unit and side effects; control flow terminates after the
assembly. Templates use AT&T x86-64 or the default ARM64 dialect and contain function-local assembly,
not module directives. LLVM operand references are `$0`, `$1`, etc.; literal `$` uses `$$`.

**Example:** `"{rdi},{rsi}"` with a unit result binds two independent input words. A memory store
must declare write/readwrite and side effects even if its result is unused.

A CPU spin hint is an observable machine effect, not a scheduler yield. On either ARM64 target,
`unsafe Intrinsic.assembly<()>("yield", "", "", "none", true, false, ())` emits the genuine
AArch64 instruction without claiming an operand, register clobber or data-memory access. A caller
requiring a compiler memory barrier may additionally declare a memory effect.

**Boundary:** The unsafe caller proves bounds, aliasing, access, lifetime and actual machine effects.
No operand grants initialization or ownership. Returning assembly preserves stack, ABI-preserved
registers and undeclared state, and never unwinds. Language borrows are not assembly operands.
Assembly that lies about memory, clobbers or returning violates its unsafe contract.

**Diagnostics:** Constraint cardinality, lane mismatch, register conflicts, invalid template
references/directives and contradictory effects diagnose structurally; the assembler diagnoses
invalid instruction spellings. No syscall behavior is inferred from instruction text.

**Evidence:** LLVM inline assembly constraints and sideeffect contract; AAPCS64 2025Q1; pinned
x86-64 psABI and Linux UAPI fixtures; Apple's
[ARM64 ABI](https://developer.apple.com/documentation/xcode/writing-arm64-code-for-apple-platforms).
`compiler/scripts/test-native-build.ts` checks Darwin hint/flags emission, native instruction text,
returning operand behavior on Darwin hosts, and rejection of reserved registers and invalid contracts.

## ASSEMBLY-003 — Naked entry fragments contain no compiler-generated work

**Status:** Candidate.

**Rule:** `@naked` and `@noReturn` require an unsafe, monomorphic, zero-argument C export
(`export "C"`) returning unit; on any other function they report SEM0236.
Its body contains exactly one terminal operand-free unit assembly call with side effects and
no-return; an enclosing `return` or unsafe acknowledgement is structural. No locals, other calls,
branches, cleanup, captures, loans or additional statements are admitted.

**Example:**

```silk
@naked
@noReturn
unsafe export "C" fn entry() -> () as "entry" {
  return unsafe Intrinsic.assembly<()>(
    "movq %rsp, %rdi\njmp native_entry_probe", "", "", "readwrite", true, true, ())
}
```

The explicit external probe receives the incoming x86-64 stack value. It is an example of a machine
fragment, not a complete process startup implementation. The selected source owns any stack
alignment or transfer policy, and the artifact supplies the external symbol.

**Boundary:** The compiler emits neither a prologue/epilogue nor an export shim around this fragment.
No implicit stack realignment, alignment override, probes or instrumentation is admitted. Sanitizer
modes, effect bodies, generic/argument-bearing functions and arbitrary native attributes are rejected.
Attributes express the validated body; actual object inspection verifies its machine shape.

**Diagnostics:** Invalid directive combinations and incompatible body/profile shapes diagnose at the
directive and body before backend execution.

**Evidence:** LLVM naked prohibits IR argument use; designated debug/optimized object and independent
C probe fixtures. Source-owned complete startup and raw OS composition remain JUL-136.
