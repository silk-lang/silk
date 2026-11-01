# Windows clocks, randomness, and stdin

`providers.silk` exercises the ordinary native providers on Windows. Its separately compiled C
companion installs real pipe, null, invalid, and write-only stdin handles. Production modules have
no fixture imports. `providers-contract.c` also builds as a standalone OS-contract executable;
passing that executable does not establish that Silk compiled or ran.

The tests establish QPC/QPF scalar and FILETIME layout contracts, an independently converted Unix
epoch, random-buffer boundaries, raw binary pipe reads, broken-pipe EOF, sticky provider EOF,
empty reads, and typed input failures. Regressions such as treating broken-pipe EOF as an error,
reading again after provider EOF, or decoding redirected input would fail
these checks. No random-quality or elapsed-time assertions are used.

Pure unit conversion cases extend the existing shared corpus program
`system-clock-make-carries-nanoseconds`; no additional Linux/macOS test root or compilation is
introduced. These cover the 1601/1970 epoch, a pre-epoch fraction, unsigned FILETIME maximum,
fractional tick rounding, signed counter/frequency maxima, nominal resolution, and finite sleep
saturation. The `WindowsTime` actor is the production timestamp/timeout conversion boundary,
also suitable for filesystem FILETIME metadata. It exposes no injection hook.

## Cross-build integration

The parent owns `cross-build.sh`, `run.ps1`, and workflow wiring. Add this fixture separately from
the existing standalone sources because it has a native companion. From the repository root,
with absolute `compiler` and `out` paths and `SILK_TEST_CLANG` pointing to LLVM 22.1.8:

```sh
repo=$PWD
pkg="$out/providers-package"
mkdir -p "$pkg/src"
cp compiler/fixtures/windows-runtime/providers.silk "$pkg/src/main.silk"
"$SILK_TEST_CLANG" --target=x86_64-pc-windows-msvc -O2 -ffreestanding \
  -fno-stack-protector -Wall -Wextra -Werror -DSILK_PROVIDER_COMPANION \
  -c compiler/fixtures/windows-runtime/providers-contract.c -o "$pkg/companion.obj"
cat > "$pkg/fixture.def" <<'EOF'
LIBRARY kernel32.dll
EXPORTS
CreatePipe
CloseHandle
SetStdHandle
EOF
llvm-dlltool -m i386:x86-64 -d "$pkg/fixture.def" -l "$pkg/fixture.lib"
cat > "$pkg/silk.toml" <<'EOF'
[package]
name = "windows-providers-fixture"
version = "0.0.0"
silk-version = "0.0.0"
[native]
link = [{ object = "companion.obj" }, { static-archive = "fixture.lib" }]
EOF
"$compiler" build "$pkg/src/main.silk" -o "$out/providers.ll" --emit llvm-ir \
  --target x86_64-pc-windows-msvc --stdlib "$repo/stdlib" --optimization none --debug false
"$compiler" build "$pkg/src/main.silk" -o "$out/providers.exe" --target x86_64-pc-windows-msvc \
  --stdlib "$repo/stdlib" --clang "$SILK_TEST_CLANG" --optimization none --debug false
llvm-readobj --file-headers --coff-imports "$out/providers.exe" > "$out/providers-pe.txt"
```

Required production imports are `QueryPerformanceCounter`, `QueryPerformanceFrequency`,
`GetSystemTimePreciseAsFileTime`, `ReadFile`, and `Sleep` in kernel32, plus `ProcessPrng` in
bcryptprimitives. `WindowsLink` generates these import libraries. The fixture adds only
`CreatePipe`, `CloseHandle`, and `SetStdHandle` through its separate archive; do not add them to
production imports for this test. Allow kernel32, ntdll, and bcryptprimitives DLLs for this program.
The other programs keep their existing import policy.

Run the C contract and supplied cross-built Silk executable on real Windows:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File compiler/fixtures/windows-runtime/run-providers.ps1 `
  -SilkExecutable C:\path\to\artifact\providers.exe
```

Omitting `-SilkExecutable` runs only the C contract and records the Silk fixture as `not-checked`.
The runner writes PE inspection and `results.json` under `.scratch/windows-providers` by default.

## Independent evidence

Sources were read at Zig 0.15.2 (`e4cbd752c8c05f131051f8c873cff7823177d7d3`) and Rust 1.90.0
(`1159e78c4747b02ef996e55082b704c09b970588`):

- [Rust Windows time](https://github.com/rust-lang/rust/blob/1159e78c4747b02ef996e55082b704c09b970588/library/std/src/sys/pal/windows/time.rs)
  establishes the 11,644,473,600-second epoch offset, precise FILETIME call, QPC/QPF selection,
  and checked duration conversion. Silk retains split seconds instead of a total u64 nanosecond
  counter and does not inherit older waitable-timer fallbacks.
- [Rust time tests](https://github.com/rust-lang/rust/blob/1159e78c4747b02ef996e55082b704c09b970588/library/std/tests/time.rs#L205)
  exercise large arithmetic and times on both sides of the epoch. They motivated fixed boundary
  cases; their elapsed-time and current-calendar assumptions are not copied.
- [Zig time implementation and tests](https://github.com/ziglang/zig/blob/e4cbd752c8c05f131051f8c873cff7823177d7d3/lib/std/time.zig#L180)
  show QPF-based scaling and the need to avoid intermediate overflow. Its fixed-point conversion
  assumes a u32 frequency and uses a wider product; Silk accepts every positive i64 frequency
  with exact floor division and needs no compiler-rt division helper.
- [Rust Windows random](https://github.com/rust-lang/rust/blob/1159e78c4747b02ef996e55082b704c09b970588/library/std/src/sys/random/windows.rs)
  uses `ProcessPrng` with a pointer-sized length. [Zig's Windows random source](https://github.com/ziglang/zig/blob/e4cbd752c8c05f131051f8c873cff7823177d7d3/lib/std/os/windows.zig#L411)
  uses the older `RtlGenRandom` API with u32 chunking. That compatibility choice does not apply
  to ProcessPrng's SIZE_T contract; it is not copied.
- [Zig ReadFile](https://github.com/ziglang/zig/blob/e4cbd752c8c05f131051f8c873cff7823177d7d3/lib/std/os/windows.zig#L619)
  and [Rust Windows handles](https://github.com/rust-lang/rust/blob/1159e78c4747b02ef996e55082b704c09b970588/library/std/src/sys/pal/windows/handle.rs#L145)
  establish DWORD transfer bounds and EOF error handling. [Rust stdin](https://github.com/rust-lang/rust/blob/1159e78c4747b02ef996e55082b704c09b970588/library/std/src/sys/stdio/windows.rs#L14)
  deliberately refreshes standard handles. Silk preserves its raw-byte contract, including the
  current console input code page, and reports canceled reads as failures rather than retrying
  indefinitely. Sticky EOF belongs to `OsStandardInput`, not the low-level Windows handle reader.
- Microsoft documents [FILETIME units and alignment](https://learn.microsoft.com/en-us/windows/win32/api/minwinbase/ns-minwinbase-filetime),
  [precise wall time](https://learn.microsoft.com/en-us/windows/win32/api/sysinfoapi/nf-sysinfoapi-getsystemtimepreciseasfiletime),
  [QPC conversion overflow and suspend semantics](https://learn.microsoft.com/en-us/windows/win32/sysinfo/acquiring-high-resolution-time-stamps),
  [ProcessPrng's BOOL/SIZE_T contract](https://learn.microsoft.com/en-us/windows/win32/seccng/processprng),
  [ReadFile broken-pipe EOF and message-pipe partial reads](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-readfile),
  and [Sleep's millisecond and infinite-wait contract](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-sleep).

## Validation state at implementation handoff

Passed on real Windows with LLVM 22.1.8: freestanding C compile with warnings as errors, no-CRT
link, PE DLL inspection, and OS-contract execution. The companion configuration also compiles
with warnings as errors. `git diff --check` passes.

Not checked: Silk fixture compilation/execution, corpus execution, generated stdlib reference,
and failure-control execution, because no local runnable Silk compiler is available. The parent
owns the N1/cross artifact and combined documentation route. No pre-change executable control
was run. Interactive console input, message-mode partial pipe reads, and forced QPC/ProcessPrng
failure branches remain unexecuted; the native C success is not evidence for those claims.
