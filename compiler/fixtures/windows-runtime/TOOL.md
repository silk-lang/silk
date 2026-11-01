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
can replace a mapped executable only while another hard link retains the original image.
Self-update serializes publication with `.update.lock` and retains `.silk-previous.exe`; the
next update removes that link once the old image is no longer mapped. If it cannot, the
current tool remains untouched. Windows has no Unix executable mode bit; marking an image executable verifies
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

Windows release archives use ZIP32, UTF-8 names and raw DEFLATE. The native reader checks central
and local records, paths, member CRCs, exact decoded lengths, duplicate names and a 1 GiB total
decoded limit. It refuses links, encrypted members, data descriptors and ZIP64. Signature and
trusted-comment verification precede decoding; the compiler must match `native-seed.json`.
Install and update use `.exe` names. Unix releases retain gzip-compressed ustar.

`WindowsInstall.silk` uses an independently encoded, Ed25519/BLAKE2b-signed test release. Native
execution proves invalid signatures and wrong compiler hashes leave no staged installation,
valid ZIPs install the expected compiler bytes, repeated installation changes nothing, and
update replaces its own running image. PowerShell independently checks the resulting bytes and
the retained image hash. The pre-fix updater failed this fixture with `cannot replace .../silk.exe`.
Evidence: `.scratch/windows-tool-zip-results/results.json` and `.scratch/windows-install-native3/`.

The existing `TarArchiveCases` root now also owns ZIP DEFLATE/CRC, unsafe path, local-header,
encryption, truncated-directory and duplicate-member assertions. All five tests passed natively
on Windows (2 ms total). The production ZIP writer passed independent libarchive extraction.
The older Unix writer tests use POSIX file modes and have a subprocess timeout on this Windows
host; their Linux CI checks remain required. No timing limits were relaxed.

Not checked by this slice: cross-process lock contention, interrupted installation recovery,
all tool source-written tests on Windows, or publishing/installing a real signed Windows release.
Release workflow assets and the PowerShell bootstrap installer still need integration.
