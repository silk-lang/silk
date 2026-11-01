# Windows executable integration

The compiler builds SDK-free x64 console executables with the LLVM installation selected by
`--clang` or `SILK_CLANG`. `driver/WindowsLink.silk` ships the minimal import definitions in the
compiler, writes them in its private build directory, and runs the sibling `llvm-dlltool`.
Clang compiles COFF and selects sibling `lld-link` with `-B <LLVM-bin>` and `-fuse-ld=lld`,
then `/nodefaultlib`, `/subsystem:console`,
and `/entry:mainCRTStartup`. No CRT archive, allocator shim, or security cookie is supplied.
Floating remainder helpers use COFF weak definitions, so an explicitly requested foreign math
library can supply `fmod` without colliding with the compiler's no-CRT implementation.

On a Windows host the final Clang request uses a private UTF-8 response file with LLVM's
Windows quoting mode. This preserves spaces, quotes, trailing backslashes, and non-ASCII paths
while avoiding CreateProcessW's 32,767 UTF-16-unit command limit. Cross-target link caches retain
the arguments before encoding the Clang request. The native compiler runner links 400 independent
empty COFF inputs from paths containing spaces, a comma, and a non-ASCII character,
then executes the result. The old direct command fails this control before Clang can run.

Ordered groups of object/archive inputs go directly to LLD in their own Windows-quoted response
files. Clang 22's [`Command::writeResponseFile`](https://github.com/llvm/llvm-project/blob/llvmorg-22.1.8/clang/lib/Driver/Job.cpp)
doubles every backslash when it creates a linker response file. That corrupts `\\?\...`
extended paths under LLD's default Windows parser; an independent 400-object Clang invocation
reproduced this without Silk. Clang runs in the private scratch directory, so `-Wl,@link-inputs-N.rsp`
needs no directory spelling and cannot split a comma in a path. The explicit response file
preserves extended paths and avoids that automatic writer. LLVM archiver requests use response
files as well. The native runner also archives those 400 inputs with a Silk export, then checks
all 401 members and that export with LLVM tools. COFF compilation omits the ELF `-fPIC` flag.

On Windows Server 2025 with LLVM 22.1.8, both the executable and archive checks passed,
as did the original unoptimized compiler build. The six shared C aggregate, vector, and
resolver corpus cases passed in debug and optimized builds. The earlier compiler fails the
long-command control before launching Clang; the driver-only response fix reaches Clang but
fails when its automatic linker response file corrupts extended paths.

The response format follows LLVM 22.1.8's
[`TokenizeWindowsCommandLine`](https://github.com/llvm/llvm-project/blob/llvmorg-22.1.8/llvm/lib/Support/CommandLine.cpp)
contract. Rust's pinned
[`linker command handling`](https://github.com/rust-lang/rust/blob/2687a5023568f1e469910a54abf2e42d979d9ab4/compiler/rustc_codegen_ssa/src/back/link.rs)
also uses response files to handle command-line limits; this does not require adopting Rust's
CRT or linker policy. The independent failure was an unoptimized native Silk compiler build
with 347 object paths totaling more than 36,000 characters before other linker arguments.

The same LLVM installation compiles the embedded TLS support source. Its writable `_tls_index`
starts at `TLS_OUT_OF_INDEXES`; the Windows loader writes the module index before entry. The
`.tls` and `.tls$ZZZ` sentinels bound LLVM's static TLS definitions. `_tls_used` contains relocated
template, index, and null callback-array addresses, and `/include:_tls_used` retains the directory.
There is no global substitute for thread-local diagnostic state or dynamic CRT initialization.

The backend lowers only compiler-authenticated system storage operations to `GetProcessHeap`,
`HeapAlloc`, `HeapReAlloc`, and `HeapFree`. Same-spelled source foreign declarations keep their
declared symbols. MIR retains its existing size, overflow, alignment, and raw-buffer relocation
rules. The ordinary source allocator owns adopted allocations. The existing execution-storage
component selects `WindowsHeap` in source and keeps its frame accounting, reservation list,
and release rules. No compiler-known standard-library actor is added.

`_fltused` is one data marker in the support object. Diagnostic TLS and the foreign personality
use explicit COFF COMDAT groups so separately compiled units share one definition. Memory helpers
and the x64 probe-only `__chkstk` are imported
from ntdll. The native toolchain proof documents the observed probe export and its support-contract
limitation. Extended compiler-rt operations are not automatically supplied: stock LLVM's i128
fixture still needs real security-cookie support and is not a passing arithmetic implementation.

## Validation

Dispatch `selfhost.yml` with `release=none` and `windows-native=true`, or dispatch `windows.yml`
with an existing dispatched Selfhost run as `source-run`. The reusable Windows lane consumes
the verified N1 artifact, cross-builds these programs through the production driver, and retains
their emitted LLVM IR, object helper inventory, PE import inspection, and per-program results.
It uploads generated `doc-reference` pages separately. Main pushes and PR pushes labelled
`windows` select this lane automatically; Linux/macOS gates do not depend on it.

Download `windows-no-crt-programs` to Windows, then run:

```powershell
& compiler/fixtures/windows-runtime/run.ps1 -ArtifactDirectory <download>
```

`hello` checks the real Silk entry and UTF-8 redirected output. `storage` checks both adopted and
sealed system allocation, emitted growth and release, preserved bytes, and source execution-frame
alignment/accounting. A refused address-space-sized allocation reaches generated null deallocation;
a refused growth must preserve the buffer count and contents. The runner checks exit status, exact output, and DLL imports and writes
`native-results.json`. Linux cross-build results explicitly leave execution not checked. Neither
runner claims interactive console behavior, i128 arithmetic, or Windows compiler self-hosting.

The fixed references informing the edge cases are [Zig's compiler runtime][zig], which exports
`_fltused` as ordinary data without libc, and [Rust's Windows allocator][rust], which keeps the
raw allocation for over-aligned storage, requires a non-null argument to `HeapReAlloc`, and
preserves the old block on reallocation failure. Silk's MIR already enforces nonzero growth and
preserves the old owner on failure. Its alignment adjustment remains above the Windows heap call.
These upstream suites were not run as Silk tests.

`tls-proof.ps1` extracts the production TLS support source, compiles an LLVM definition with the
same storage shape as `LlvmCode.activeSteps`, and drives it from separately compiled C on two
threads. Two separately emitted units must share one state within each thread. Both threads must
start with null state and preserve distinct values across synchronization. Floating-point operations
in both units require the single support marker. The link runs through the production Clang flags.
The runner inspects the PE TLS directory, object address relocations, image base relocations, and
exact DLL imports. Without support it must fail to link on `_tls_index`; replacing TLS with a
global must fail the worker's initial-state check. This reduced native proof passed on Windows
10.0.26100 with LLVM 22.1.8. It does not claim to execute Silk. The layout follows the fixed
[Zig Windows TLS implementation][zig-tls], with no callbacks because Silk needs no TLS constructors.

[zig]: https://github.com/ziglang/zig/blob/738d2be9d6b6ef3ff3559130c05159ef53336224/lib/compiler_rt.zig
[rust]: https://github.com/rust-lang/rust/blob/2687a5023568f1e469910a54abf2e42d979d9ab4/library/std/src/sys/alloc/windows.rs
[zig-tls]: https://github.com/ziglang/zig/blob/738d2be9d6b6ef3ff3559130c05159ef53336224/lib/std/os/windows/tls.zig
