# Win64 scalar C ABI oracle

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
This fixture does not prove Windows runtime entry, linking, SEH unwinding, or aggregate/vector ABI
support. It requires neither Windows SDK headers nor a C runtime.

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
and bare narrow-integer lanes. Windows aggregate/vector support remains an explicit gap instead
of inheriting another target's rules.
