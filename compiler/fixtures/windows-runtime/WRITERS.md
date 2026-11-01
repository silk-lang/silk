# Windows native writers

`StdoutWriter`, `StderrWriter`, and `LockedStderr` use the Windows console provider.
Redirected handles receive unchanged bytes through `WriteFile`. Console handles receive UTF-16
through `WriteConsoleW`. Vectored writes decode the concatenation, so a character can cross slice
boundaries. Invalid or incomplete canonical WTF-8 fails; output before a failure remains visible.
The provider does not retain incomplete characters between separate writes.

Stderr uses one process-lifetime recursive critical section. The no-CRT support object supplies
zero-initialized, eight-byte-aligned storage for `INIT_ONCE` and the 40-byte Win64 critical section,
exposed through immutable C pointer globals. Ordinary Silk source performs synchronous once
initialization, publication, acquisition, and release. There is no callback, CRT stream, or new
compiler intrinsic. The lock is never deleted while other threads might use it. A failed
initialization traps rather than allowing an unlocked write.

The Windows critical section's recursion is required by `StderrWriter.print` inside a held
`LockedStderr`; a nonrecursive SRW lock would deadlock. Direct runtime reports intentionally do not
take this lock, so a trap while initializing it does not recurse through initialization.

## Evidence

Run `compiler/fixtures/windows-runtime/run-writer-lock.ps1` on Windows. It extracts the production
support storage, compiles a separate C Win32 contract oracle, and links without a CRT. On Server
2025 with LLVM 22.1.8 this passed: a different thread cannot acquire after two recursive entries,
still cannot acquire after one release, and can acquire after the second release. Each worker
also observes completed once initialization. Only Kernel32 is imported. Results are retained in
`.scratch/windows-writer-lock/results.json`.

The shared `stderr-locked-message` corpus case is included in the Windows cross/native harness.
Its existing exact stdout/stderr oracle distinguishes recursive nested output, plain writes under
the lock, gathered buffer overflow, flush, drop, and empty-buffer writes. Actual Silk execution
of this addition is not yet checked. Native console rendering and concurrent Silk writers remain
not checked; the C oracle proves the host primitive and storage ABI, not Silk lowering.

## Reference comparison

[Rust's pinned Windows stdio implementation](https://github.com/rust-lang/rust/blob/1159e78c4747b02ef996e55082b704c09b970588/library/std/src/sys/stdio/windows.rs#L102)
also distinguishes consoles with `GetConsoleMode` and converts text for `WriteConsoleW`. Rust
keeps incomplete UTF-8 between writes. Silk's current provider instead requires complete canonical
WTF-8 per operation, including a whole vectored operation, and accepts lone surrogates as host
values. This restriction is explicit in the public comments. Redirection preserves binary bytes
in both implementations.

[Microsoft's critical-section contract](https://learn.microsoft.com/en-us/windows/win32/sync/critical-section-objects)
specifies recursive acquisition and a matching release count. The three worker probes test that
contract without inferring exclusion from elapsed time.
