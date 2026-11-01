# Native Windows Silk tool

The tool uses `MachineFileSystem` for absolute host paths, including changeset commands, and
stops ancestor discovery at Windows volume roots. Windows home selection uses `SILK_HOME` or
`USERPROFILE/.silk`. Bundled discovery asks the OS for the actual loaded executable and finds
`silkc.exe` beside it. Forwarding uses the same Windows process-image provider as the compiler:
explicit image, inherited standard handles, current environment, wait, and exact DWORD exit.

The former compiler-local Windows host-path and process-image implementations now live in
`silk.platform.windows.host_path` and `silk.platform.windows.process_image`. Compiler callers and
fixtures use those modules directly. No second Windows implementation or compatibility wrapper
is retained. Environment operations distinguish replacing a value from setting a default.

Tool install host operations use a real `LockFileEx` lock, `CreateHardLinkW`, and class-65 NT
rename with `REPLACE_IF_EXISTS | POSIX_SEMANTICS`, without ignoring readonly attributes. This
can replace a mapped executable while its running process and older hard links retain the
original image. Windows has no Unix executable mode bit; marking an image executable verifies
that the filesystem entry exists. New objects inherit Windows permissions.

Actual native validation on Server 2025 with LLVM 22.1.8:

- Built and executed the Windows tool with native Silk N2.
- Forwarded `--version` to the actual sibling Windows compiler.
- Created a changeset in a package whose directory contains spaces, using an absolute native
  `--dir` argument. The runner inspected the generated Markdown independently.
- A dedicated production-provider fixture hard-linked its own loaded image and replaced its
  executable path with different bytes while still running. After exit, PowerShell verified the
  replacement bytes and that the retained hard link's SHA-256 still matched the original PE.
- Emitted the same tool sources as Linux LLVM IR, and checked the compiler package on Windows
  after moving the shared host modules.

Local evidence: `.scratch/windows-tool-native-results/results.json`, corresponding stdout/stderr
logs, `.scratch/windows-tool-build.log`, and `.scratch/windows-tool-linux-build.log`.
The shared `cross-host.sh` builds the compiler or tool from an existing Linux N1. `run-tool.ps1`
repeats native command and mapped-image assertions; Windows CI uploads its results.

Not checked by this slice: a complete signed Windows release install/update, cross-process lock
contention, interrupted installation recovery, or the tool's source-written tests on Windows.
ZIP distribution and Windows archive selection still need the release integration work.
