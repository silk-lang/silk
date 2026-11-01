# Windows compiler host boundaries

Machine paths use `/C:/...`, distinct from an OsFileSystem provider's confined `/`.
`MachineFileSystem` selects a persistent per-drive provider, preserving its temporary-name counter.
It requires local NTFS. Symbolic links and junctions resolve within the selected drive through
retained directory handles; other-drive targets, unknown reparse tags, and UNC operations are
unsupported. See the filesystem fixture for the confined traversal contract.
WindowsPath resolution preserves canonical WTF-8, normalizes relative components within a volume,
and rejects drive-relative names. A relative compiler path across volumes becomes absolute.

CommandPath uses semicolon-separated PATH entries, quoted directories and native executable names.
WindowsHostPath opens files/directories with zero desired access and full read/write/delete sharing,
then queries the final DOS path. InstalledCompiler queries the loaded module rather than trusting
argv[0]. NativeToolchain translates path arguments, including split-codegen inputs and outputs,
only at the external tool boundary. Cache identities remain machine paths.

The filesystem fixture from run `41262234641`, source `ccd7033c7`, passed on Windows Server 2025.
It exercises machine routing, temporary paths, invalid and unsupported roots, host canonicalization,
loaded-image discovery and PATH candidates. The host-independent corpus also covers volume escape,
UNC roots and lone-surrogate resolution. The lock/rename assertions from run `41262758747`,
source `ba9689edd`, also passed locally as an actual Silk executable, including exclusive-lock
refusal through an independent C handle and successful locking after the Silk handle closes.

HostRename uses MoveFileExW with REPLACE_EXISTING and no COPY_ALLOWED. DetachedWriter uses a
synchronous LockFileEx lock on the first byte of a stable lock file; readers take a shared lock.
The file cannot be deleted while held. Writes remain synchronous: the plan's permitted fallback
avoids reconstructing the live semantic store in a detached child. The native relaunch experiment
and its measurements are in `CACHE-WRITER.md`; no detached writer mode is shipped.

ProcessImage uses explicit CreateProcessW application names, the shared MSVC command encoder,
duplicated standard handles and an explicit handle list. It inherits the live environment and
current directory, keeps the parent alive during Ctrl+C, waits, and forwards all 32 exit-code bits.
Default environment assignment preserves existing empty variables. Missing standard handles and
batch files are refused. The new process fixture mode independently checks stdin, stdout, stderr,
argument parsing, inherited/default/empty environment and exit 259. The actual Silk executable
from run `41263604498` passed locally after correcting its C oracle to accept Windows pipe EOF
(`ERROR_BROKEN_PIPE`) as well as zero-byte file EOF. Only the oracle child was rebuilt locally;
the Silk executable was used unchanged. A fresh combined CI execution remains pending.

The Windows workflow also cross-builds the full compiler and runs `run-compiler.ps1`: version,
hello compilation through native Clang to a path containing spaces, hello execution, and checking
the compiler's sources. `cross-host.sh` extracts the current production WindowsLink import
definitions so an older N1 can link newly introduced OS calls. It restores the authored manifest
after the build. This supplements imports only; it supplies no compiler/runtime implementation.
The native compiler, N2 IR fixpoint, tool build, ZIP packaging, and building a new project from
that ZIP passed in Selfhost run `41279080373` on source `2e968c341`. The local response-file
runner also passed long executable and archive links with spaces, commas, and Unicode paths.

Pinned references:

- [Rust canonicalization](https://github.com/rust-lang/rust/blob/1159e78c4747b02ef996e55082b704c09b970588/library/std/src/sys/fs/windows.rs#L1489)
  uses zero access, BACKUP_SEMANTICS and GetFinalPathNameByHandleW with DOS volume spelling.
- [Rust locking](https://github.com/rust-lang/rust/blob/1159e78c4747b02ef996e55082b704c09b970588/library/std/src/sys/fs/windows.rs#L355)
  handles pending locks for asynchronous file handles. Silk's cache handles are synchronous.
- [Rust inherited stdio](https://github.com/rust-lang/rust/blob/1159e78c4747b02ef996e55082b704c09b970588/library/std/src/sys/process/windows.rs#L593)
  duplicates standard handles with SAME_ACCESS and inheritance enabled. Silk additionally uses a
  HANDLE_LIST. Rust propagates missing streams; Silk's current interactive boundary refuses them.
- [Zig final-path queries and tests](https://github.com/ziglang/zig/blob/e4cbd752c8c05f131051f8c873cff7823177d7d3/lib/std/os/windows.zig#L1277)
  distinguish DOS/NT volume spelling and test exact buffer-size failures. Silk resizes bounded buffers.

Not checked: interactive Ctrl+C, missing-stream support, concurrent interactive launches,
cross-volume rename refusal, lock waiter wakeup, forced allocation failures,
forced lock-owner termination and Windows 10 behavior.
