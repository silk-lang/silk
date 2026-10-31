# Windows entry and host input slice

This slice adds ordinary Silk source for synchronous `mainCRTStartup`, Windows process-heap
allocations, command-line and environment capture, and standard-handle output. It shares the
existing `NativeReport` and diagnostic observer. It does not install OS fault handlers, support
parking, change filesystem/process APIs, supply a CRT, or change the native seed.

The portable `windows-host-codecs` corpus case supplies literal UTF-16 tables and independently
specified output bytes. Its assertions cover argv[0] quote rules, modern MSVC quoting, slash
parity, empty arguments, unmatched quotes, raw surrogates, NUL rejection, canonical WTF-8
boundaries, malformed encodings, and hidden environment-name separators. The parser is never
tested solely by parsing its own argument encoder. There is no argument encoder in this slice.

## Integration

The Windows target/ABI work must supply `x86_64-pc-windows-msvc`, `libc = "system"`, Win64
foreign calls, and COFF emission. The runtime composition selects `silk/platform/windows/start`.
`hello.silk` is the small integration program. It uses `WindowsConsole` explicitly; the POSIX
`writer_native` locking API is not ported by this slice.

Also cross-build `host-check.silk` and run `run-host.ps1 -Executable <host-check.exe>` once the
runtime links. That fixture additionally imports `SetEnvironmentVariableW` for its child-local
snapshot mutation check. The launcher supplies a fixed raw command line and a lone-surrogate
environment value. It checks actual Silk argument parsing, case-insensitive raw lookup, snapshot
stability, over-aligned storage, overflow refusal, and exact redirected output. Until it runs,
those implementation claims remain not checked; the C OS-contract probe does not replace it.

The linker owner must generate a Kernel32 import library for these exact names:

```text
ExitProcess
GetProcessHeap
HeapAlloc
HeapFree
GetCommandLineW
GetEnvironmentStringsW
FreeEnvironmentStringsW
CompareStringOrdinal
GetCurrentDirectoryW
GetStdHandle
GetConsoleMode
GetLastError
WriteFile
WriteConsoleW
```

Link COFF with `/nodefaultlib /machine:x64 /subsystem:console /entry:mainCRTStartup` and an
`.exe` output. Inspect PE imports to reject CRT imports. LLVM-emitted memory helpers, `__chkstk`,
and `_fltused` remain with the linker/runtime-symbol owner, as established by the no-CRT proof
in PR #2681. Compiler MIR still names `malloc`, `realloc`, and `free`; allocation drop glue can
retain `free` even when an allocation has a source reclaim callback. Those compiler-owned runtime
bindings must be resolved before claiming an executable. Do not mask them with CRT shims.

System `Allocator` requests on Windows adopt a `HeapAlloc` allocation with a `HeapFree` reclaim
callback, including alignment padding. They decline the libc-specific in-place growth path.
Execution-storage reservations and diagnostic pools still require the separately owned Windows
execution-storage binding. Until that module admits Windows, `NativeDiagnostics` cannot import its
`ExecutionStorage` type on this target. `WindowsHeap.acquire` and `WindowsHeap.release` are available
for that binding, with the existing reservation accounting retained by its owner.

## Host contracts

WTF-8 stays in byte APIs. Valid pairs in UTF-16 become one scalar; lone surrogates survive.
Raw decoding rejects adjacent separately encoded high and low surrogates, overlong encodings,
truncation, bad continuation bytes, and values above U+10FFFF. The codec preserves NUL; host
command-line and environment-name boundaries reject it. `HostInput.text` still rejects lone surrogates.

An empty command line produces one empty argv[0]. This is explicit and differs from Rust's
current-executable fallback. Leading space/tab gives empty argv[0]. Only space and tab separate
arguments. No wildcard expansion, shell parsing, or `CommandLineToArgvW` substitution occurs.

Environment capture owns a copy and always releases `GetEnvironmentStringsW` storage, including
on allocation failure. A leading `=` is part of a name, so `=C:=C:\work` is split after `=C:`.
Malformed entries without a separator are ignored. Lookup validates canonical WTF-8 and NUL,
uses `CompareStringOrdinal(..., TRUE)`, and selects the first matching snapshot entry. This uses
Windows' case table, not ASCII folding or a locale-sensitive language transformation. Directory
lookup returns the native Windows spelling as raw WTF-8. Portable `Path` spelling is deferred.

Console output uses `GetConsoleMode` to distinguish real consoles from redirected handles.
Redirected output preserves arbitrary bytes with `WriteFile`. A real console requires one complete
canonical WTF-8 sequence per write and receives UTF-16 with `WriteConsoleW`; code pages do not change.
Both paths handle partial writes and reject zero progress. Writes are not message-locked.

## Validation limits

`run-environment.ps1` builds and runs `environment-contract.c` with LLVM 22.1.8, without a CRT.
It passed on this Windows host. The PE imports only Kernel32. This independent OS probe checks
non-ASCII case matching against `GetEnvironmentVariableW`, ordinal no-expansion (`ß` versus `SS`),
distinct capital/final sigma names, lone-surrogate values, and a snapshot retained across mutation.
Mutation stays inside the short-lived probe process. Results and PE inspection are retained under
`.scratch/windows-environment`. These assertions verify the OS premises, not Silk provider execution.

The Windows-only source requires target integration before it can be type-checked and emitted.
The portable corpus runs through existing Linux CI. No Windows execution, allocator failure
injection, snapshot-lifetime execution, real-console readback, or Win32 child argument oracle is
claimed solely from those portable tables. Run `hello.exe` both redirected and on a real console,
then inspect PE imports and test the host provider before treating this slice as a Windows runtime.
Generate `reference/stdlib` with `silk doc-reference --stdlib-root stdlib --output reference/stdlib`
when a native Silk compiler is available. Its explicit profile enumeration in
`compiler/src/documentation/Command.silk` also needs Windows for the combined target/runtime
reference. The parent owns that compiler edit. No Linux/macOS workflow changes are required here.

## Pinned upstream references

These sources inform edge cases; their implementation is not used as a test oracle at runtime.

- [Zig 0.15.2 `unicode.zig`, e4cbd752][zig]: the test at line 2013 explicitly shows that adjacent
  separately encoded surrogate halves do not preserve bytes through UTF-16. Silk rejects those
  noncanonical bytes instead of silently normalizing them.
- [Rust 1.90.0 `wtf8.rs`, 1159e78c][rust-wtf8] and its [fixed tables][rust-wtf8-tests]: `from_wide`
  preserves lone surrogates and combines valid pairs. `push_wtf8` also combines pairs formed at
  concatenation boundaries. The corpus includes a lone high surrogate immediately before a valid pair.
- [Rust Windows argument parser][rust-args] and its [fixed expectation tests][rust-args-tests]:
  argv[0] is separate, and doubled quotes inside later quoted arguments follow post-2008 MSVC rules.
- [Rust Windows environment iterator][rust-env]: search for the separator after the first code
  unit to preserve hidden names that begin with `=`.
- [Microsoft command-line rules][ms-args], [ordinal comparison][ms-compare], and
  [WriteConsole][ms-console] supply the host contracts.

[zig]: https://github.com/ziglang/zig/blob/e4cbd752c8c05f131051f8c873cff7823177d7d3/lib/std/unicode.zig#L2013
[rust-wtf8]: https://github.com/rust-lang/rust/blob/1159e78c4747b02ef996e55082b704c09b970588/library/std/src/sys_common/wtf8.rs
[rust-wtf8-tests]: https://github.com/rust-lang/rust/blob/1159e78c4747b02ef996e55082b704c09b970588/library/std/src/sys_common/wtf8/tests.rs
[rust-args]: https://github.com/rust-lang/rust/blob/1159e78c4747b02ef996e55082b704c09b970588/library/std/src/sys/args/windows.rs
[rust-args-tests]: https://github.com/rust-lang/rust/blob/1159e78c4747b02ef996e55082b704c09b970588/library/std/src/sys/args/windows/tests.rs
[rust-env]: https://github.com/rust-lang/rust/blob/1159e78c4747b02ef996e55082b704c09b970588/library/std/src/sys/env/windows.rs
[ms-args]: https://learn.microsoft.com/en-us/cpp/c-language/parsing-c-command-line-arguments
[ms-compare]: https://learn.microsoft.com/en-us/windows/win32/api/stringapiset/nf-stringapiset-comparestringordinal
[ms-console]: https://learn.microsoft.com/en-us/windows/console/writeconsole
