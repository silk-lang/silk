# Windows diagnostic frames

Unoptimized Windows objects use `RtlCaptureStackBackTrace` to capture up to 256 physical
frames and `RtlLookupFunctionEntry` to map each return address to the function's entry.
The existing reporter limits the result to 64 named Silk frames and appends suspended
coroutine callers through the existing step records. A leaf without an unwind-table entry
has no recoverable exact entry address and is not named by this walk.

The compiler subtracts one from each return address before lookup, so a return immediately
after a function's final instruction still resolves inside the caller. The returned
`RUNTIME_FUNCTION.BeginAddress` is a 32-bit image-relative offset, added to the 64-bit image
base. Windows builds emit neither `_Unwind_Backtrace` nor `_Unwind_GetRegionStart`.

COFF orders the `.silk$A`, `.silk$M`, and `.silk$Z` contributions. The production support
object defines start/end sentinels; each compiler unit contributes its function/name pairs
to the middle section. ELF's implicit section-boundary symbols are not assumed on COFF.

Run the independent OS ABI and section-ordering probe:

```powershell
& compiler/fixtures/windows-runtime/run-frame-walk.ps1
```

It compiles a C caller chain with a 32 KiB frame and real unwind tables, links the production
support source and imports, and verifies that both named frames are recovered in stack order.
The control omits unwind tables and must fail the same observation with exit 13. Both passed
on Windows Server 2025 with LLVM 22.1.8. Results and PE unwind inspection are retained in
`.scratch/windows-frame-walk`. This proves the OS ABI and section layout; compiler-generated
frame-walk execution remains not checked until the new N1 produces a native executable.

Microsoft contracts:

- [CaptureStackBackTrace](https://learn.microsoft.com/en-us/windows/win32/api/winnt/nf-winnt-rtlcapturestackbacktrace)
- [RtlLookupFunctionEntry](https://learn.microsoft.com/en-us/windows/win32/api/winnt/nf-winnt-rtllookupfunctionentry)
- [RUNTIME_FUNCTION](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-runtime_function)
- [PE/COFF section grouping](https://learn.microsoft.com/en-us/windows/win32/debug/pe-format#grouped-sections-object-only)

[Zig 0.15.2's Windows walk](https://github.com/ziglang/zig/blob/e4cbd752c8c05f131051f8c873cff7823177d7d3/lib/std/debug.zig#L1003)
uses `RtlCaptureContext`, `RtlLookupFunctionEntry`, and `RtlVirtualUnwind` on x64, including
explicit leaf-frame and stack-bound checks. Silk's live diagnostic path delegates that traversal
to `RtlCaptureStackBackTrace` and uses the same image-relative function-table lookup for naming.
Unlike Zig's exception-context path, this does not reconstruct an earlier SEH fault context.
