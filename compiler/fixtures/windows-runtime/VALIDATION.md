# Windows feature validation

The feature targets `x86_64-pc-windows-msvc`, LLVM 22, and Windows system DLLs without a C
runtime. Native evidence below comes from Windows Server 2025 x64. The pinned seed is unchanged.

## Full acceptance corpus

The full native Windows run after the ABI, socket, response-file, and confined-link fixes reports:

```text
Selfhost corpus: pass=852 fail=0 unsupported=14 track=389
Selfhost gap DIAGNOSTIC_PARITY: 14
```

This includes all 641 native and 225 invalid programs. All required track cases passed. The
14 unsupported records match the Linux run `41275833947` exactly, including diagnostic codes
and source spans; they remain unsupported rather than being counted as passes. Updating the
borrow-gap baseline with the repository tool produced no count changes.

The earlier Windows run had five failures and four additional unsupported ABI cases. The
current full run passes those cases, including `glob-scan`, both native socket cases,
`network-address-resolution`, and C aggregate/vector boundaries. It retains the shared corpus
and the full track rather than selecting a smaller Windows subset.

Local evidence:

- `.scratch/windows-full-current.utf8.log`: complete classifications and compiler receipts.
- `.scratch/windows-diagnostic-parity-current.json`: Linux 14, Windows 14, differences 0.
- `.scratch/windows-reparse-compiler.exe`: native compiler used for the run, SHA-256
  `92cd673000ce8b8dac4f4b37e5dd2fa50d2ce2aac58939a3d18f42db0330eb09`.

This compiler contains the ABI, response-file, and `NtFsControlFile` import changes; the runner
compiles the current stdlib and corpus sources for each case. It predates the confined-link
provider implementation in its own host filesystem, so this local run is not a native compiler
generation fixpoint. The Windows workflow separately builds N2, checks the IR fixpoint, and runs
the full corpus with that N2.

## Independent boundaries and distribution

Selfhost run `41279080373`, source `2e968c341`, passed all jobs: Linux corpus and source tests,
incremental replay budgets, ARM Linux and macOS, plus the Windows native N2 fixpoint, ZIP
packaging, and a new project built with the extracted Windows toolchain. Later Windows fixture
run `41281753301`, source `8d1e4440f`, passed the cross-build, actual runtime fixtures, and tool
commands with mapped-image publication. Its separate compiler/corpus job supplies its own
generation evidence; consult that job's final result rather than inferring it from fixture passes.

Focused retained evidence is indexed in `LINKING.md`, `HOST.md`, `NETWORKING.md`, `TOOL.md`,
`WRITERS.md`, `FRAMES.md`, and `../windows-filesystem/README.md`. These include native negative
controls for TLS isolation, unwind/frame metadata, socket deadlines and cleanup, retained file
handles, signed installation, and source-generated executable behavior.

## Deliberate limits

- Filesystem roots require NTFS. Confined symbolic links and junctions are supported. The
  subsequent UNC fixture passes reads, writes, creation, stat, and listing through both providers
  (`.scratch/windows-filesystem-combined-unc/results.json`). Remote atomic publication is refused
  before staging; deletion needs server POSIX disposition support. Device/non-NTFS roots,
  unknown reparse tags, and directory durability are unsupported. The SMB probe establishes
  why NTFS naming alone does not establish rename/delete contracts. No weaker fallback is used.
- Windows semantic cache writes are synchronous. `CACHE-WRITER.md` records the real detached
  reconstruction experiment supporting the plan's permitted fallback.
- Windows ARM64 and DLL output are outside this target. Windows 10 has not been validated.
- The 14 diagnostic-parity gaps also exist on Linux. They were not repaired or suppressed by
  this platform feature. Fixture-specific untested error injection and OS scenarios remain
  listed with their owning proof.
- Signed local release fixtures and ZIP installation are tested; publishing a real release and
  registering a public Scoop bucket are not actions performed by this feature branch.
