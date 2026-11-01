# Windows filesystem provider slice

This fixture accompanies `silk.platform.windows.filesystem` and its selection in `OsFileSystem`.
It implements reads, truncating writes, exclusive creation, metadata, byte-sorted directory
listing, directory creation/removal, temporary directories, and buffered atomic publication.
Relative symbolic links resolve within the provider root. Absolute symbolic links and junctions
resolve only when their native target names that root or a descendant.

The intended floor is Windows 10 1809 with local NTFS. The native oracle has passed on
**Windows Server 2025 Datacenter Evaluation, 10.0.26100, x86-64**, with stock LLVM 22.1.8.
The Windows 10 floor itself and other Windows versions remain **not checked**. The Silk provider
has compiled and executed on Server 2025. No security, Developer Mode, or antivirus settings were changed.

## Boundaries

- `Path("/")` still means the provider root. `OsFileSystem.make("C:\\work")` supplies a
  separate host root. `makeBytes` accepts canonical WTF-8; it never converts raw host values
  to a UTF-8 `string`. Invalid constructor roots trap, consistent with the existing constructor.
- Roots use normalized absolute drive paths, with backslash separators. UNC, device, verbatim,
  volume-GUID, drive-relative and slash-rooted inputs are rejected. Native-root normalization,
  drive selection, and translation from compiler host paths remain integration work.
- Portable components cannot contain backslashes or colons. Every component is validated as
  canonical WTF-8 before conversion. Malformed bytes and separately encoded surrogate pairs
  fail with `InvalidPath`. Trailing dots/spaces use counted NT-name semantics, not Win32 trimming.
- The root and its ancestors are trusted, as in the existing provider. Each operation opens
  and holds the root and traverses below it with one-component `NtCreateFile` calls relative
  to parent handles. Root-volume queries reject remote devices and filesystem names other
  than NTFS. Names are never lowercased; `OBJ_CASE_INSENSITIVE` is absent.
- All opens share read, write, and delete access. Access rights depend on the operation.
  Reparse points are opened themselves and read with `FSCTL_GET_REPARSE_POINT`. Relative target
  components resolve through retained directory handles; `..` stops at the root. Absolute NT
  targets must match the root's component spelling except drive-letter case. Outside targets
  and aliases with different root spellings fail `Unsupported`. No unchecked kernel reparse
  traversal is enabled. More than 40 links fails with `InvalidPath`. Known final links can be
  listed, removed, and replaced without following them. Unknown tags fail `Unsupported`;
  no unknown-tag fixture has yet been executed.
- Directory queries use counted `FileIdExtdDirectoryInformation` records, validate bounds,
  read fields without alignment assumptions, preserve UTF-16 names through WTF-8, and report
  link tags before the directory attribute. The existing common provider sorts path bytes.
- Atomic publication retains the staging file handle and uses `FileRenameInformationEx`.
  Flags are POSIX semantics plus replace-if-exists only for replacement. Create-new has no
  existence-check race. There is no delete-rename, copy, cross-volume, or legacy fallback.
  Eight-character staging names avoid generated DOS short-name aliases. A conservative ASCII
  case comparison prevents a staging name from aliasing the requested destination; it does
  not normalize user paths or cache keys. Only name collisions retry, at most 128 times.
- Removal uses handle disposition with DELETE and POSIX flags. It does not set
  IGNORE_READONLY_ATTRIBUTE. A successful disposition is followed by closing the deleting
  handle. Existing handles to replaced/deleted objects remain valid.
- Directory durability has no established implementation. `syncDirectory` and synchronized
  publication return `Unsupported`; the latter does so before creating a temporary file.
  Buffered publication records `published=true` immediately after a successful rename,
  before fallible close operations. Cleanup preserves the primary error and residual name.
- Filesystem provider codes are raw signed **NTSTATUS** bit patterns. These operations never
  read `GetLastError`, convert to DOS errors, or retry access-denied/sharing errors. Logical
  validation errors have no provider code. Sharing conflicts remain `Other` with the NTSTATUS.

## Proof and running it

`contract.c` is an independent, SDK-free C fixture. C ABI structures have compile-time layout
assertions and cross the DLL boundary only by pointer. It creates names and retains file
handles through Win32 APIs, then exercises the exact NT operation contracts used by Silk.
It does not compile or call Silk when run alone.

```powershell
& compiler/fixtures/windows-filesystem/run.ps1
```

The runner builds a no-CRT executable, uses a new scratch directory, and retains its stdout,
stderr, host identity, and filesystem tree under `.scratch/windows-filesystem`. Symlink
privilege failure is a reported unsupported outcome, never a passing skip. It neither follows
links for recursive cleanup nor changes system security. The oracle proves:

- NT root and empty-name reopening, local-NTFS queries, synchronous no-follow opens;
- operation-specific read/write/truncate rights and EOF status;
- atomic create collision and replacement retaining an independently opened old handle;
- POSIX deletion followed by recreation while the old handle stays readable;
- delete-sharing conflicts and read-only deletion/replacement refusal;
- final directory symlink and junction deletion leaving an outside sentinel unchanged;
- dangling and directory symlink replacement affecting the link itself;
- directory record layout, counted lone-surrogate names, and distinct directory/link kinds.
- per-directory case sensitivity retaining distinct `Name` and `name` files.

`provider.silk` is the integration test. Its independent C setup creates a lone-surrogate
filename, outside-target symlink/junction, and an old file. Assertions cover actual provider
operations, sorted names, raw NTSTATUS sharing errors, outside-target and durability refusal,
malformed WTF-8 and namespace rejection, retained old handles, failed-publication cleanup,
exclusive creation, temporary directories, and nonempty-directory refusal. It is not counted
as passing until it has compiled and executed. There are no compiler exports or hooks added
solely for this test.

The test-audit authoring gate for these additions is: existing portable corpus cases cannot
independently create Windows UTF-16 names, retain native handles, or establish NT ABI layouts.
Wrong share masks, follow flags, rename flags, directory offsets, tags, or UTF-16 conversion
make these checks fail for distinct reasons. These focused fixtures do not duplicate a full
native corpus run. No pre-change Silk execution control or Linux timing is available.

After the integration owner adds the imports below, cross-build with the already-built N1:

```bash
bash compiler/fixtures/windows-filesystem/cross-build.sh "$N1" "$OUT/windows-filesystem"
```

The dedicated script creates an isolated package and links the C oracle support object with
the normal Silk Windows runtime. It leaves shared runners/workflows untouched. On Windows:

```powershell
& compiler/fixtures/windows-filesystem/run.ps1 -SilkExecutable C:\artifacts\provider.exe
```

The integrated provider has been cross-built by Silk and executed on real Windows in
[Windows run 41271694441](https://github.com/silk-lang/silk/actions/runs/41271694441).
The separate C oracle establishes the OS contracts; the Silk executable validates their
integration with the language runtime. The same workflow also passes the native compiler
fixpoint. Generated standard-library reference pages are included in the feature branch.

The follow-up traversal fixture passed locally with native Silk and LLVM 22.1.8. It reads
an absolute file symlink and an in-root junction, clamps a relative `../..` target at the root,
follows a final link for ordinary writes, refuses exclusive creation at that link, and replaces
the link itself during atomic publication. An outside junction remains unsupported; a relative
escape can reach only the provider's own namespace, and the independent outside sentinel stays
unchanged. Evidence is in `.scratch/windows-reparse-provider/native/results.json`.
The shared `glob-scan` corpus passes literal versus wildcard traversal, dangling links, dot and
parent targets, and a real cycle. Its adapted Windows fixture failed before the traversal change
with exit 2 and passes afterward. Kernel handling of arbitrary reparse tags is never delegated.

## Host integration

`WindowsLink` includes these **nine** filesystem exports in its `ntdll.dll` import library:

```text
NtCreateFile
NtClose
NtQueryInformationFile
NtQueryVolumeInformationFile
NtSetInformationFile
NtReadFile
NtWriteFile
NtQueryDirectoryFile
NtFsControlFile
```

The provider needs no new kernel32 export. The fixture's separate `kernel32.def` supplies its
Win32 oracle only. NT information classes are 5 (standard), 35 (attribute/tag), 60 (extended
directory), 20 (EOF), 64 (disposition Ex), 65 (rename Ex), and volume 4/5 (device/attributes).
All file I/O uses synchronous handles and caller-owned buffers; no pending asynchronous buffer
can escape. Root names are counted `UNICODE_STRING` values with a `\??\` prefix.

Compiler host callers use `MachineFileSystem` for absolute machine paths, with explicit
Windows drive roots. `OsFileSystem` keeps provider-relative paths confined. Host path discovery
converts native WTF-8 working-directory and executable names into the machine namespace.
Cache keys are not globally lowercased: case-sensitive NTFS directories can contain distinct
spellings. The native compiler check, build, and fixpoint exercise this integration.

Remaining evidence gaps include unknown-tag creation, explicit
ACL fixtures, two simultaneous publishers, injected close
failures, Windows 10 execution, long host roots, and unsupported-filesystem rejection on a
non-NTFS test volume. These are not passing claims.

## Pinned references consulted

- [Zig 0.15.2 NT opens](https://github.com/ziglang/zig/blob/e4cbd752c8c05f131051f8c873cff7823177d7d3/lib/std/os/windows.zig#L72):
  RootDirectory, sharing, operation-specific rights, and omitted OBJ_CASE_INSENSITIVE.
- [Zig rename](https://github.com/ziglang/zig/blob/e4cbd752c8c05f131051f8c873cff7823177d7d3/lib/std/posix.zig#L2823):
  counted rename buffers and Windows version gates. Its legacy fallback and readonly override are not copied.
- [Zig directory iteration](https://github.com/ziglang/zig/blob/e4cbd752c8c05f131051f8c873cff7823177d7d3/lib/std/fs/Dir.zig#L429):
  counted records. Silk checks the reparse tag before the directory bit.
- [Rust 1.90 Windows filesystem](https://github.com/rust-lang/rust/blob/1159e78c4747b02ef996e55082b704c09b970588/library/std/src/sys/fs/windows.rs#L775):
  handle deletion and unaligned directory records. Its weak deletion fallback is not copied.
- [Rust Windows path handling](https://github.com/rust-lang/rust/blob/1159e78c4747b02ef996e55082b704c09b970588/library/std/src/sys/path/windows.rs#L98)
  and [tests](https://github.com/rust-lang/rust/blob/1159e78c4747b02ef996e55082b704c09b970588/library/std/src/sys/path/windows/tests.rs#L38):
  verbatim, UNC, device, and drive-relative boundaries. This slice accepts a smaller explicit root grammar.
- [Rust WTF-8](https://github.com/rust-lang/rust/blob/1159e78c4747b02ef996e55082b704c09b970588/library/std/src/sys_common/wtf8.rs#L230)
  and [tests](https://github.com/rust-lang/rust/blob/1159e78c4747b02ef996e55082b704c09b970588/library/std/src/sys_common/wtf8/tests.rs#L100):
  exact UTF-16 code-unit preservation and lone surrogates.
