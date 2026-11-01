# Win64 C ABI oracles

`scalars.c` is a header-free, independent C fixture. `scalars.ll` was emitted by stock Clang
22.1.8, LLVM revision `ca7933e47d3a3451d81e72ac174dcb5aa28b59d1`, on Windows x86-64.
It establishes that signed and unsigned 8-bit and 16-bit C parameters and results have no
`signext` or `zeroext` at declarations, direct calls, indirect calls and definitions.
The C static assertions independently establish 8-byte pointers and 4-byte C `long` size/alignment.

From this directory, regenerate with LLVM 22.1.8:

```sh
clang --target=x86_64-pc-windows-msvc19.33.0 -std=c11 -O1 -ffreestanding \
  -fno-ident -fno-discard-value-names '-fdebug-compilation-dir=.' \
  -S -emit-llvm scalars.c -o scalars.ll
```

The explicit MSVC environment version keeps the oracle independent of Clang's host default.
Silk's canonical target name is `x86_64-pc-windows-msvc`.
`SemanticLoweringCases.win64NarrowCDeclarationsCallsCallbacksAndExportsStayBare` checks Silk IR
against these signatures. Existing SysV and GNU ARM64 cases retain their distinct extension rules.
This scalar fixture requires neither Windows SDK headers nor a C runtime.

`aggregates.c` and the independently emitted `aggregates.ll` establish the Win64 record and
vector rules. Regenerate with the scalar command above, substituting `aggregates.c` and
`aggregates.ll`. Records of exactly 1, 2, 4, or 8 bytes use integer lanes; a single `float`
field still uses `i32`. Other nonempty records use caller copies and `sret`, without LLVM
`byval`. A struct containing one vector is still a record and uses this indirect rule.

LLVM vector arguments stay vector-typed. LLVM lowers them to aligned caller copies passed by
pointer, while results use vector registers. Replacing those LLVM parameters with pointers
would apply lowering twice. Clang's assembly for `vector_identity` loads from RCX into XMM0;
`call_copies` puts its vector in an aligned local before passing its address to `consume`.
Silk admits 128-, 256-, and 512-bit vectors with SSE2, AVX, and AVX-512F respectively.

Clang's empty MS C record extension has size 4; Silk's empty records have size zero. Empty
by-value records, including records containing them through fields or arrays, remain an explicit
ABI gap rather than silently using incompatible offsets.
`win64CRecordsAndVectorsUseTheirOwnCallingConvention` checks the independent signatures in the
existing semantic test root. The shared `foreign-struct-values`, `foreign-struct-vectors`,
`foreign-c-layout-lifetime`, `foreign-nullable-callback`, and `simd-c-vectors` corpus cases
provide separately compiled C witnesses for execution, callbacks, exports, and caller copies.
All five passed on Windows Server 2025 with a compiler built from this implementation and
Clang 22.1.8; `.scratch/windows-corpus-abi.log` records the focused run. The Win64 scalar and
positive record/vector lowering assertions also passed natively. Local timings are diagnostic;
Linux CI checks their required timing budget.

## Upstream comparison

Reviewed on 2026-10-31, with immutable upstream revisions:

- [Rust Win64 classifier, `2687a5023568f1e469910a54abf2e42d979d9ab4`](https://github.com/rust-lang/rust/blob/2687a5023568f1e469910a54abf2e42d979d9ab4/compiler/rustc_target/src/callconv/x86_win64.rs)
  treats 8/16/32/64-bit aggregates as integer lanes and other aggregates as indirect values.
  It calls `extend_integer_width_to(32)` for small scalars. This differs from the Clang C IR
  above, so Silk does not copy that extension policy.
- [Rust target specification at the same revision](https://github.com/rust-lang/rust/blob/2687a5023568f1e469910a54abf2e42d979d9ab4/compiler/rustc_target/src/spec/targets/x86_64_pc_windows_msvc.rs)
  confirms 64-bit pointers and the Windows data layout. Its additional baseline CPU features
  are Rust's platform policy; Silk retains its existing LLVM x86-64 baseline.
- [Rust C integer-widening regression at the same revision](https://github.com/rust-lang/rust/blob/2687a5023568f1e469910a54abf2e42d979d9ab4/tests/ui/abi/cabi-int-widening.rs)
  sends `-1` through an `i8` C argument and checks the widened result. It supports testing negative
  values across the boundary, but does not by itself establish the LLVM extension attributes.
- [Zig LLVM lowering, `738d2be9d6b6ef3ff3559130c05159ef53336224`](https://github.com/ziglang/zig/blob/738d2be9d6b6ef3ff3559130c05159ef53336224/src/codegen/llvm.zig)
  has separate Win64 return and parameter classification. Its `ccAbiPromoteInt` also selects
  narrow integer extensions on x86-64, another difference from the retained Clang fixture.
- [Zig Win64 register sets at the same revision](https://github.com/ziglang/zig/blob/738d2be9d6b6ef3ff3559130c05159ef53336224/src/codegen/x86_64/abi.zig)
  distinguish RCX/RDX/R8/R9 arguments and callee-saved RSI/RDI from SysV. Silk therefore leaves
  Windows native assembly unavailable until its register contract is implemented separately.
- [Zig C ABI tests](https://github.com/ziglang/zig/blob/738d2be9d6b6ef3ff3559130c05159ef53336224/test/c_abi/main.zig)
  and their [C translation unit](https://github.com/ziglang/zig/blob/738d2be9d6b6ef3ff3559130c05159ef53336224/test/c_abi/cfuncs.c)
  exercise signed and unsigned narrow arguments and returns in both directions. This informs
  the fixture coverage, without claiming that Zig's suite was run here.

Microsoft's [x64 calling convention](https://learn.microsoft.com/en-us/cpp/build/x64-calling-convention?view=msvc-170)
specifies right-justified integer arguments whose upper bits the callee can ignore, and undefined
unused return bits. It also specifies 16-byte stack alignment and distinct aggregate rules.
Its [64-bit data model](https://learn.microsoft.com/en-us/windows/win32/winprog64/abstract-data-models)
specifies LLP64. These contracts and the independent C fixture determine Silk's machine facts
and bare narrow-integer lanes. The Win64 record classifier is separate from SysV and ARM64.

## Foreign personality ABI and native SEH proof

`seh-personality.c` independently spells Microsoft's
[x64 exception routine](https://learn.microsoft.com/en-us/cpp/build/exception-handling-x64?view=msvc-170).
Clang emits `i32 (ptr, i64, ptr, ptr)`: exception record, `ULONG64 EstablisherFrame`, context,
and dispatcher context. `seh-personality.ll` retains that independent output. Regenerate it
from this directory with Clang 22.1.8:

```sh
clang --target=x86_64-pc-windows-msvc19.33.0 -O2 -ffreestanding -fno-stack-protector \
  -Werror -fno-ident -fno-discard-value-names '-fdebug-compilation-dir=.' \
  -S -emit-llvm seh-personality.c -o seh-personality.ll
```

`LlvmCode` uses this signature both for the handler definition and for foreign-guard references,
including reclaim guards and coroutine steps. ELF and Mach-O retain the five-argument Itanium
signature. The existing Windows scalar lowering case checks the complete emitted handler
signature and reclaim guard; the SysV foreign-contract case checks the five-argument signature.
These source tests run in the existing semantic lowering root.

Run the opt-in native proof from the repository root:

```powershell
& compiler/fixtures/windows-abi/check-seh.ps1
```

The runner needs the shared portable LLVM 22.1.8 installation, with no SDK or CRT. It compiles
the C signature and fast-fail oracle, checks its emitted IR, and compiles the reduced handwritten
`seh-guard.ll` separately from `seh-caller.c`. It verifies the handler's SEH relocation and
symbol inventory, links with `/nodefaultlib`, and requires imports from only Kernel32
and NTDLL. The unguarded `RaiseException` control reaches the outer C catch and exits 98;
the guarded call must terminate through Windows fast fail (`0xC0000409`, signed exit
-1073740791), with reason `FAST_FAIL_FATAL_APP_EXIT` (7), before that catch.
Both observations passed on this Windows x64 host. Three additional guarded executions
confirmed the same exit after investigating the unstable trap control.
Commands, Clang IR, symbols, unwind records, imports and structured results remain under
`.scratch/windows-abi-seh`.

The native control exposed an unstable assumption in the first reduced toolchain proof:
`llvm.trap` becomes `ud2`, which raises another dispatchable exception from inside SEH.
Both four- and five-argument trap handlers produced `STATUS_ACCESS_VIOLATION` (`0xC0000005`)
in some executions. Changing the handler to local linkage initially appeared to fix it,
but a subsequent run reproduced the access violation. Linkage was not a valid explanation.
Windows therefore uses the independently emitted `__fastfail(7)` instruction sequence,
`int 0x29` with the reason in ECX. Microsoft's
[fast-fail contract](https://learn.microsoft.com/en-us/cpp/intrinsics/fastfail?view=msvc-170)
specifies non-continuable termination without invoking exception handlers, which prevents
nested exception dispatch. The existing hidden `linkonce_odr` definition remains on every
target, including Mach-O where coalescing avoids the compact-unwind personality limit.

[Rust's SEH implementation](https://github.com/rust-lang/rust/blob/2687a5023568f1e469910a54abf2e42d979d9ab4/library/panic_unwind/src/seh.rs)
uses CRT `__CxxFrameHandler3`, C++ exceptions and LLVM funclets. Silk's forbidden-unwind contract
does not require that runtime. Rust's
[foreign-exception test](https://github.com/rust-lang/rust/blob/2687a5023568f1e469910a54abf2e42d979d9ab4/tests/run-make/foreign-exceptions/foo.cpp)
provides the useful outer-catch control pattern, without importing its cross-language unwinding
policy or claiming its tests passed here.

The shared `foreign-direct-forbidden-unwind`, `foreign-indirect-forbidden-unwind`, and `foreign-callback-forbidden-unwind`
fixtures additionally execute real Silk boundaries with an exact fast-fail status requirement.
The C-only outer-catch control distinguishes the guard from an escaped exception. Their C
objects need `-funwind-tables`: without unwind tables, an exception can terminate before
reaching the control's catch and falsely look like a working guard. Runtime frame walking and
helper inventories have separate fixtures under `windows-runtime`.
