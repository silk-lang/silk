# Windows process and thread contracts

`run-command-line.ps1` builds and runs an independent, freestanding Windows C oracle. It launches
itself with an explicit application path and a separately spelled argument zero. The child uses
Windows' `CommandLineToArgvW` to check literal argument expectations, including empty arguments,
spaces, quote/backslash boundaries, shell metacharacters, and a lone UTF-16 surrogate.

The parent waits before reading the exit value. Exit 259 is an ordinary completed result, and
an explicit `ExitProcess(0xc0000005)` preserves every bit. A high NTSTATUS-shaped value alone
does not establish that the child crashed. The production process provider must not infer that
distinction from the number.

The oracle imports Kernel32 and Shell32, with no CRT. Shell32 is test-only and does not belong in
Silk's production import libraries. It passed on Windows Server 2025 with LLVM 22.1.8. The runner
retains PE inspection and a result ledger in `.scratch/windows-process`.

`CommandLine.encode` implements the production UTF-16 encoder. Fixed expected code-unit arrays
extend the existing `windows-host-codecs` corpus case; they do not use Silk's parser to generate
or validate their expectations. Limit cases exercise exactly 32,767 code units including NUL and
the first refused length. These are semantic length constraints, not performance budgets.

The encoder's host-independent corpus has passed with N1 on Linux. The C oracle is evidence for
the operating-system contracts only.

`WindowsProcess.execute`, selected by `OsChildProcess`, now implements explicit application
selection, canonical WTF-8 inputs, sorted case-insensitive environment names with duplicate
rejection, and a double-NUL empty environment. Windows paths use the machine namespace. Batch
files are rejected. Named output pipes use overlapped reads and manual-reset events; pending
operations own stable heap buffers and are cancelled and completed before freeing storage.
An explicit attribute list admits only stdin, stdout, and stderr. The child starts suspended,
enters a kill-on-close Job, and resumes. Failure kills and waits for the child. Once the child
exits, closing the Job terminates remaining descendants so inherited output pipes cannot keep
capture blocked forever. A completed DWORD is reinterpreted as signed i32 without losing bits.

`provider.silk` executes a separately compiled C child whose Shell32 parser and Win32 queries
check quote/backslash/empty/surrogate arguments, raw case-insensitive environment, absence of a
parent-only variable, stdin EOF, and Job membership. The child writes 64 KiB to each pipe and
leaves a sleeping descendant holding the pipes. The Silk fixture asserts every byte, exits 259
and 0xc0000005, batch rejection, and duplicate-name rejection. The C child's Win64 structure
assertions and freestanding compilation with LLVM 22.1.8 pass. Silk compiled the provider and
fixture from `c6b2d2f8b` using N1 from `943142c73` in
[run 41259800219](https://github.com/silk-lang/silk/actions/runs/41259800219). That older compiler
lacked the new production imports. Locally linking its unchanged emitted objects with the
current production support/import supply passed native execution with exit zero and no output.
Evidence is `.scratch/windows-process-relink/results.json`. The later run 41260286867 built and
linked source `1063f6105` using N1 from `c6b2d2f8b`; native execution passed without relinking.
That run also passed the added assertion that the child cannot signal an unrelated inheritable
parent event. Failed allocation during pending I/O, nondefault working directory, and concurrent
launch remain not checked.

`run-thread.ps1` separately checks `CreateThread`'s DWORD result, argument passing, an 8 MiB
stack reservation, wait-before-read ordering, handle closure, processor counts, zero-timeout
comparison semantics, and address wakeups. It passed on this Windows host, importing only
Kernel32 and `api-ms-win-core-synch-l1-2-0.dll`.

The production Windows branches use the existing `NativeThread` ownership and result storage.
Joining and dropping both wait, then close the thread handle. `Atomic.wait` rounds finite bounds
up to milliseconds and returns a spurious wakeup when a clamped bound expires. The Windows
cross-build reuses `native-thread-spawn-join`, `native-thread-cross-wake`, and `atomic-wait-notify`
from the existing corpus; no Linux test root was added. All three passed actual Windows execution
from run 41259150694. Forced thread creation failures remain unverified.

Pinned sources consulted:

- [Rust 1.90 Windows arguments](https://github.com/rust-lang/rust/blob/1159e78c4747b02ef996e55082b704c09b970588/library/std/src/sys/args/windows.rs#L174)
  doubles trailing slashes and adds an escape before a quote. Silk always quotes arguments, so
  its result has one spelling independent of whitespace heuristics.
- [Zig 0.15.2 process command lines](https://github.com/ziglang/zig/blob/e4cbd752c8c05f131051f8c873cff7823177d7d3/lib/std/process/Child.zig#L1548)
  establishes the special argv[0] rule and rejects embedded quotes there. Its separate batch-file
  path is not copied: the forthcoming direct-executable provider must reject batch execution.
- [Microsoft CreateProcessW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw)
  documents the mutable command line, explicit application name, and 32,767-code-unit limit.
- [Microsoft GetExitCodeProcess](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getexitcodeprocess)
  documents why the wait must establish termination before interpreting 259.
- [Rust Windows threads](https://github.com/rust-lang/rust/blob/1159e78c4747b02ef996e55082b704c09b970588/library/std/src/sys/pal/windows/thread.rs#L30)
  uses a DWORD trampoline, `STACK_SIZE_PARAM_IS_A_RESERVATION`, and a waited handle. Its historical
  sleep fallbacks are unrelated to Silk's address-wait operation.
- [Microsoft WaitOnAddress](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitonaddress)
  specifies spurious returns, pointer-sized comparison lengths, and ERROR_TIMEOUT. The runtime
  uses the synchronization API set already established by the no-CRT fixture.
