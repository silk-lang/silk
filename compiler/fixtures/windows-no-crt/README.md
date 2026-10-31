# Native Windows no-CRT toolchain proof

This opt-in fixture prepares Windows linking before Silk has a Windows runtime. It
compiles C and handwritten LLVM IR with stock LLVM 22.1.8, generates import libraries
from minimal `.def` files, links with `lld-link /nodefaultlib`, inspects PE imports,
and runs real x64 executables. It does not build Silk, modify the pinned seed, or
add a CI lane. No Windows SDK headers or import libraries are needed.

From a 64-bit PowerShell process at the repository root:

```powershell
& compiler/fixtures/windows-no-crt/provision.ps1
& compiler/fixtures/windows-no-crt/run.ps1
```

Provisioning requires `gh`, `curl.exe`, and Windows `tar.exe`. It reads the official
[LLVM release](https://github.com/llvm/llvm-project/releases/tag/llvmorg-22.1.8),
requires the exact portable asset `clang+llvm-22.1.8-x86_64-pc-windows-msvc.tar.xz`,
and checks both its published digest and downloaded SHA-256:

```text
d96c2cc1736f4eb7fa43cb9bbdf56d93551a9ae0a9aadb9c99c3c3b2b712a234
```

The asset was available and verified on 2026-10-31. The archive is 862,053,924 bytes.
The default install is
`C:\Users\Administrator\silk-windows-tools\clang+llvm-22.1.8-x86_64-pc-windows-msvc\bin`
on this host (`$env:USERPROFILE` on another host). It contains `clang.exe`,
`lld-link.exe`, `llvm-dlltool.exe`, `llvm-readobj.exe`, `llvm-nm.exe`, and
`llvm-objdump.exe`. Provisioning changes no PATH, machine configuration, or security
settings, and needs no installer or reboot. `-ToolsRoot` selects another local
directory. `run.ps1 -LlvmBin <bin> -OutputDirectory <directory>` overrides its paths.

## What the proof checks

The runner retains exact commands, object symbol inventories, disassembly, DLL
exports, PE headers/imports, child output, and structured `results.json` under
`.scratch/windows-no-crt`. Its zero exit means the expected observations hold;
`results.json` separately records functionality that remains not checked.

The essential build commands, with `src`, `out`, and LLVM's `bin` resolved by the
runner, are:

```text
llvm-dlltool -m i386:x86-64 -d <src>/ntdll.def -l <out>/ntdll.lib
clang --target=x86_64-pc-windows-msvc -O2 -ffreestanding -fno-stack-protector -c <src>/smoke.c -o <out>/smoke.obj
lld-link /nodefaultlib /machine:x64 /subsystem:console /entry:mainCRTStartup /out:<out>/smoke.exe <out>/smoke.obj <out>/float-support.obj <out>/kernel32.lib <out>/ntdll.lib <out>/synchronization.lib
llvm-readobj --file-headers --coff-imports <out>/smoke.exe
```

Each check has an independent failure condition:

- `smoke.exe` validates memory fill/copy/overlapping move/compare, a 32 KiB stack
  frame, floating-point arithmetic, process heap allocation/free, and address-wait
  API-set loading. It writes `windows-no-crt: ok` through `WriteFile`, then exits 0
  through `ExitProcess`. Object checks require all memory references, `__chkstk`,
  and `_fltused`, so optimization cannot silently remove a claimed case. A link
  without the local `_fltused` definition must fail.
- Exact import-DLL allowlists reject accidental CRT imports. The baseline imports
  only `kernel32.dll`, `ntdll.dll`, and `api-ms-win-core-synch-l1-2-0.dll`. PE headers
  must identify AMD64, console subsystem, and a nonzero entry point.
- `builtins.ll` inventories actual LLVM lowering for variable i128 division,
  remainder, multiply, shift, and signed/unsigned conversions to/from double.
  `builtins-entry.ll` keeps every operation reachable at link time. Both the absent
  runtime and stock compiler-rt link failures are checked. Extended arithmetic is
  **not executed** because the stock library has unresolved security-cookie support.
- `foreign-guard.ll` reduces the shape of `LlvmCode.guard`, `invokeGuarded`, and
  `defineForeignPersonality`. The object must register its personality in SEH
  unwind metadata. A separately compiled C caller catches a `RaiseException` in
  the unguarded control (exit 98), while the guarded call must terminate with
  `STATUS_ILLEGAL_INSTRUCTION`, `0xC000001D` (signed exit -1073741795), before the
  outer C catch. The trap child disables only its own interactive error dialogs.

## Observed results and plan corrections

All baseline and reduced SEH checks passed on Windows Server 2025 Datacenter
Evaluation, 10.0.26100, x64, with Clang/LLD 22.1.8. The executable inspection proves
no CRT imports for these fixtures, not absence of Windows' own internal dependencies.

`ntdll.dll` exports exactly `__chkstk` on this host. LLVM emits that symbol; it is
not `_chkstk` or `___chkstk_ms`. KernelBase and Kernel32 also export it, forwarding
to `NTDLL.__chkstk`. Microsoft's [helper documentation][ms-chkstk] names KernelBase
as the export provider. The plan's direct ntdll import works here; this observation
does not establish its support contract across all Windows versions. The routine
uses the compiler's special stack-probe convention, so it must not be modeled as
an ordinary source-callable C function.

`WaitOnAddress` and `WakeByAddress*` are real KernelBase exports on this machine,
absent from Kernel32's export table. The plan's API-set name is correct and agrees
with Microsoft's [WaitOnAddress requirements][ms-wait]. The API-set DLL need not
exist as a file: this host resolves the import contract successfully. The smoke
uses unequal values for immediate return and calls both wake functions; it does
not prove blocking, timeout, or multithreaded wake behavior. Export inventories
also confirm `ProcessPrng` in `bcryptprimitives`, `WSAStartup`/`socket` in `ws2_32`,
and the certificate-store operations in `crypt32`. No unused import definitions
or claims of executing those APIs are added.

The i128 object emits `__divti3`, `__udivti3`, `__modti3`, `__umodti3`,
`__floattidf`, `__floatuntidf`, `__fixdfti`, `__fixunsdfti`, and `_fltused`.
Multiply and shift introduce no additional undefined helpers in this probe.
Stock `lib/clang/22/lib/windows/clang_rt.builtins-x86_64.lib` contains the arithmetic
helpers, but linking the reachable set fails on **`__security_cookie` and
`__security_check_cookie`**. `-fno-stack-protector` on the fixture cannot remove
instrumentation already present in that archive. No dummy cookie, checker, CRT
dependency, or arithmetic implementation is supplied. Before these operations
are needed, choose a freestanding builtins supply or implement proper cookie
initialization/checking. Microsoft [requires cookie initialization before protected
functions][ms-cookie] when startup bypasses the CRT. This probe is an LLVM risk
inventory, not evidence that current Silk source emits all these operations.

The reduced foreign guard **does compile and trap on SEH**; a blanket claim that
its `landingpad` cannot lower to Windows would be incorrect. Its five-argument
Itanium-shaped personality is nevertheless not a Windows handler signature:
Microsoft documents a [four-argument exception routine][ms-seh]. This reduced
personality ignores every argument and immediately traps, which explains the
observed success. Before production Windows support, make that ABI explicit and
run Silk's direct, indirect, and callback forbidden-unwind corpus cases with a
Windows C fixture. Their existing `<unwind.h>`/`_Unwind_RaiseException` fixture
is not a Windows SEH test. Neither those corpus cases nor Silk's fatal observer
machinery were executed here.

## Upstream implementation and test references

Sources were inspected at fixed revisions, not used as compatibility requirements:

- Zig [`stack_probe.zig` at 738d2be9][zig-stack] distinguishes probe-only x64
  `__chkstk` from routines that also adjust the stack. This supports checking the
  exact emitted symbol instead of aliasing similarly named routines. Its
  [`compiler_rt.zig`][zig-runtime] supplies `_fltused` locally without libc, matching
  this fixture's local marker strategy. Zig implements its own probe; this proof
  deliberately tests the Windows system export proposed in the plan.
- Zig's [`divti3_test.zig`][zig-div-test] tests signed arithmetic results, including
  sign and boundary cases. Symbol availability alone is not arithmetic proof.
  This runner therefore keeps extended arithmetic execution as `not-checked`
  after the stock runtime link failure instead of treating its symbol inventory
  as a passing computation test.
- Rust [`panic_unwind/src/seh.rs` at 2687a502][rust-seh] describes its use of
  `_CxxThrowException`, CRT `__CxxFrameHandler3`, and LLVM funclets. Its
  [`foreign-exceptions` C++ fixture][rust-foreign] uses an outer catch and verifies
  cross-language unwinding/destruction. The outer-catch control is useful evidence
  here, but Rust's unwind policy and CRT machinery are not suitable defaults for
  Silk's forbidden-unwind, no-CRT contract.
- Rust's [`tests/ui/abi/stack-probes.rs`][rust-stack-test] exercises recursive and
  oversized-frame failures in subprocesses. Our smaller frame exercises normal
  stack growth and the imported helper; it does not claim overflow reporting or
  thread-stack coverage. None of the upstream test suites were run here.

The next dependencies are the separate Silk Windows target/runtime work, a
production foreign-handler ABI, and a no-CRT builtins policy if the emitted IR
needs the extended helpers. Filesystem, process, and path API choices remain with
their owning work areas. These fixtures add no Silk API or compatibility layer.

[ms-chkstk]: https://learn.microsoft.com/en-us/windows/win32/devnotes/-win32-__chkstk
[ms-wait]: https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitonaddress
[ms-cookie]: https://learn.microsoft.com/en-us/cpp/c-runtime-library/reference/security-init-cookie?view=msvc-170
[ms-seh]: https://learn.microsoft.com/en-us/cpp/build/exception-handling-x64?view=msvc-170
[zig-stack]: https://github.com/ziglang/zig/blob/738d2be9d6b6ef3ff3559130c05159ef53336224/lib/compiler_rt/stack_probe.zig
[zig-runtime]: https://github.com/ziglang/zig/blob/738d2be9d6b6ef3ff3559130c05159ef53336224/lib/compiler_rt.zig
[zig-div-test]: https://github.com/ziglang/zig/blob/738d2be9d6b6ef3ff3559130c05159ef53336224/lib/compiler_rt/divti3_test.zig
[rust-seh]: https://github.com/rust-lang/rust/blob/2687a5023568f1e469910a54abf2e42d979d9ab4/library/panic_unwind/src/seh.rs
[rust-foreign]: https://github.com/rust-lang/rust/blob/2687a5023568f1e469910a54abf2e42d979d9ab4/tests/run-make/foreign-exceptions/foo.cpp
[rust-stack-test]: https://github.com/rust-lang/rust/blob/2687a5023568f1e469910a54abf2e42d979d9ab4/tests/ui/abi/stack-probes.rs
