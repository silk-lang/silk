# Windows executable integration

The compiler builds SDK-free x64 console executables with the LLVM installation selected by
`--clang` or `SILK_CLANG`. `driver/WindowsLink.silk` ships the minimal import definitions in the
compiler, writes them in its private build directory, and runs the sibling `llvm-dlltool`.
Clang compiles COFF and calls the sibling `lld-link` with `/nodefaultlib`, `/subsystem:console`,
and `/entry:mainCRTStartup`. No CRT archive, allocator shim, or security cookie is supplied.

The backend lowers only compiler-authenticated system storage operations to `GetProcessHeap`,
`HeapAlloc`, `HeapReAlloc`, and `HeapFree`. Same-spelled source foreign declarations keep their
declared symbols. MIR retains its existing size, overflow, alignment, and raw-buffer relocation
rules. The ordinary source allocator owns adopted allocations. The existing execution-storage
component selects `WindowsHeap` in source and keeps its frame accounting, reservation list,
and release rules. No compiler-known standard-library actor is added.

`_fltused` is a link-once data marker. Memory helpers and the x64 probe-only `__chkstk` are imported
from ntdll. The native toolchain proof documents the observed probe export and its support-contract
limitation. Extended compiler-rt operations are not automatically supplied: stock LLVM's i128
fixture still needs real security-cookie support and is not a passing arithmetic implementation.

## Validation

Dispatch the existing `selfhost.yml` with `release=none` and `windows-smoke=true`. The optional
job consumes that run's verified N1 artifact, cross-builds these programs through the production
driver, and retains their emitted LLVM IR, object helper inventory, PE import inspection, and
per-program results. It uploads generated `doc-reference` pages separately. It adds no work or
dependency to default Linux, macOS, or performance jobs.

Download `windows-no-crt-programs` to Windows, then run:

```powershell
& compiler/fixtures/windows-runtime/run.ps1 -ArtifactDirectory <download>
```

`hello` checks the real Silk entry and UTF-8 redirected output. `storage` checks both adopted and
sealed system allocation, emitted growth and release, preserved bytes, and source execution-frame
alignment/accounting. The runner checks exit status, exact output, and DLL imports and writes
`native-results.json`. Linux cross-build results explicitly leave execution not checked. Neither
runner claims interactive console behavior, i128 arithmetic, or Windows compiler self-hosting.

The fixed references informing the edge cases are [Zig's compiler runtime][zig], which exports
`_fltused` as ordinary data without libc, and [Rust's Windows allocator][rust], which keeps the
raw allocation for over-aligned storage, requires a non-null argument to `HeapReAlloc`, and
preserves the old block on reallocation failure. Silk's MIR already enforces nonzero growth and
preserves the old owner on failure. Its alignment adjustment remains above the Windows heap call.
These upstream suites were not run as Silk tests.

[zig]: https://github.com/ziglang/zig/blob/738d2be9d6b6ef3ff3559130c05159ef53336224/lib/compiler_rt.zig
[rust]: https://github.com/rust-lang/rust/blob/2687a5023568f1e469910a54abf2e42d979d9ab4/library/std/src/sys/alloc/windows.rs
