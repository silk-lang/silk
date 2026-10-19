# Handoff: filesystem capabilities needed by Changeset

## Goal

Extend Silk's filesystem APIs so an external Silk library can publish complete files without truncating live files, refuse accidental overwrites without a check-then-write race, and explicitly request durable filesystem updates.

The motivating consumer is the `changes/` workspace package, now linked into the native
`silk changes` command. Its release touches the package manifest, generated Markdown, TOML
release records, and pending change files.

**Historical design handoff:** the filesystem API work below has since landed in `stdlib/`.
The observations and proposed contracts describe the original standalone prototype's needs.
The consumer still uses its ordinary-write backup journal; adopting atomic/durable publication
is a separate change, not a guarantee provided by the CLI integration.

## Repository starting points

All paths below are relative to the Silk repository root. Read `AGENTS.md` first. Keep policy in
ordinary Silk and native bindings at the native boundary. Nothing here calls for a
compiler-known filesystem actor or new intrinsic.

| File                                  | Relevant implementation                                                                   |
| ------------------------------------- | ----------------------------------------------------------------------------------------- |
| `stdlib/silk/filesystem.silk`         | Portable filesystem service and publication contracts.                                    |
| `stdlib/silk/os_filesystem.silk`      | Native operation dispatch and operation/close failures.                                   |
| `stdlib/silk/native_filesystem.silk`  | Descriptor-relative traversal, no-follow policy, native publication, and synchronization. |
| `changes/src/tests/ReleaseCases.silk` | Consumer fault injection and rollback scenarios.                                          |

Search all `FileSystem` implementations before extending the service, including in-memory providers, fixtures, examples, and the changes package's fault-injection provider.

## Original observed gaps

### 1. No exclusive regular-file creation

`FileSystem.writeFile` explicitly has create-or-truncate semantics. `NativeFileSystem.openFile(..., writing: true, ...)` uses `CREATE` without `EXCLUSIVE`, inspects the file, then calls `ftruncate(..., 0)`.

Native platform sections already declare an `EXCLUSIVE` flag constant, but the inspected regular-file open path does not use it. `createUnique` exclusively creates **directories**, not regular files.

Consequences:

- `exists(path)` followed by `writeFile(path, bytes)` is not a safe no-overwrite operation.
- A random filename reduces collision probability but does not make creation exclusive.
- Changeset currently serializes its own writers with an exclusively created directory. Noncooperating writers are not covered.

### 2. No atomic replacement or rename operation

Neither the portable filesystem service nor the inspected native filesystem boundary exposes rename or atomic file replacement.

An ordinary write truncates the live destination before writing its new contents. A partial write can therefore leave an empty or truncated manifest/changelog. Other readers can observe that intermediate state.

Changeset's real-filesystem regression tests deliberately leave a four-byte changelog prefix to verify recovery from this failure.

### 3. No explicit durability operations

The inspected APIs expose no file synchronization or directory synchronization operation. Closing a handle is not a power-loss durability guarantee.

This prevents Changeset from expressing the required ordering between:

1. writing backup contents;
2. making backup directory entries durable;
3. publishing a durable recovery-ready marker;
4. replacing live files;
5. durably removing consumed changes;
6. durably retiring the recovery marker and journal.

The current implementation deliberately makes **no power-loss durability claim**.

### 4. No advisory lock handle — useful, but not a blocker

There is no exposed advisory file-lock operation. However, `createDirectory` already provides exclusive namespace creation, which is sufficient to serialize cooperating Changeset writers.

Do not make a general locking subsystem a prerequisite for the three capabilities above. Automatic lock release on process exit would be useful separately, but it would not replace the release journal or make multiple file changes atomic.

## Recommended API scope and semantics

### A. Explicit no-overwrite creation

Expose a regular-file creation operation that atomically claims an absent name. A name that already exists must never be truncated or replaced.

Required semantics:

- Refuse existing files, directories, and symlink entries without following or modifying them. Document their precise typed error categories.
- Implement the claim in the native creation operation, not with `exists` followed by ordinary writing.
- Preserve exact path bytes and the existing provider-root confinement policy.
- Specify what remains if writing or closing fails after the file was created.
- Do not claim complete-content visibility merely because the name was created exclusively: direct exclusive creation can still expose a partially written new file.

Prefer to also support no-overwrite **atomic publication** through the whole-file operation below. That gives `silk changes add` both collision safety and complete-content visibility.

### B. Provider-owned atomic whole-file publication

Provide a high-level operation such as `writeFileAtomic`, with an explicit destination policy:

- **Replace:** atomically replace an existing regular file, or create one if absent.
- **Create new:** atomically publish only if no destination entry exists; otherwise refuse without modifying it.

Required semantics:

- Stage a uniquely claimed temporary regular file in the destination directory, on the same filesystem.
- Write the complete contents to the staged file before publication.
- Publish using a real atomic namespace operation. Never implement replacement by unlinking the destination first.
- Implement create-new publication with an actual no-replace primitive/protocol. A preflight existence check followed by replacing rename is still racy.
- Readers opening the destination see a complete old or new file, never an intermediate prefix or a replacement-induced missing-name interval. This does not promise a multi-file snapshot.
- Before publication, failure leaves the old destination unchanged, or the previously absent destination absent.
- Clean up unneeded staging files when possible. If cleanup fails, preserve the primary failure and make the residual state diagnosable.
- Do not fall back to copy-and-delete for cross-filesystem moves. Same-directory staging should avoid that case; exposed lower-level move operations must refuse unsupported atomicity.
- Define handling of destination directories and symlinks without weakening confinement. Do not follow a destination symlink and overwrite its referent.
- Specify file-mode/metadata behavior. Replacing an inode is not the same as truncating it: permission bits, hard links, ownership, ACLs, and extended attributes need an explicit supported contract. Do not silently promise preservation the provider cannot implement.

A public general-purpose rename operation is optional if atomic publication is provider-owned. Keep native descriptor/rename details private unless another real consumer needs them.

### C. Explicit file and directory durability

Add the native primitives and portable surface needed to request durable writes and namespace changes.

Recommended shape:

- A distinct durability policy on atomic whole-file publication, rather than silently adding synchronization cost to every existing `writeFile` call.
- Synchronize staged file contents before publication when durable publication is requested.
- Synchronize the containing directory after publication.
- Expose directory synchronization, or an equally expressive durable namespace-operation API, so a caller can order journal directory creation, marker publication, and file/directory removal.
- Synchronize the actual owned file handle being written, not a later path lookup that could refer to another inode.
- Handle synchronization failures explicitly. If a provider/platform cannot support the requested guarantee, return a typed unsupported/failure result; do not silently downgrade to an ordinary write.

Document the exact durability level supported on Darwin and GNU/Linux. In particular, distinguish normal filesystem synchronization from stronger hardware-cache flush guarantees; do not equate a successful syscall or a process-kill test with proven power-loss safety.

### D. Publication state must survive failure reporting

An atomic namespace change can succeed and a later directory synchronization or cleanup can fail. In that case the destination **has already changed**, even though the overall operation failed.

The API must distinguish at least:

- Failure before publication: destination was not changed by this operation.
- Failure after publication: new contents are visible, but the requested durability or cleanup guarantee was not completed.

Use an explicit result/error representation, not an undocumented interpretation of a generic `FileError`. Include the relevant operation/reason and retain native error details where available. The exact type design belongs to the implementing agent.

Do not blindly retry an operation whose publication already succeeded. Preserve the existing rule that close is not retried indiscriminately after `EINTR`.

## What must remain application-owned

**Atomic replacement of one file does not create a transaction over several paths.**

Even with all the additions above, Changeset still needs a release protocol coordinating its manifest, changelog, and pending changes. A process can stop between two successful atomic replacements. Directory synchronization improves durability, not cross-file atomicity.

Do not introduce a general filesystem transaction engine for this task. Do not delete Changeset's journal simply because rename is available.

Changeset's current protocol, in `changes/src/Release.silk`:

- `add`: acquire `.changes/.lock`, record the new filename with an empty directory inside the lock, write the pending file, remove the marker, release the lock.
- `version`: lock; parse and validate; save original files and pending changes; create `ready`; write manifest/changelog; remove consumed changes; remove `ready`; clean up the journal.
- `recover`: with `ready` present, restore originals and removed pending files; without it, finish cleanup. An interrupted add marker identifies the partial new file to remove.

A later consumer migration should use atomic publication for live files, durable ordering for the journal when requested, and explicit publication-state errors. That migration must preserve the recovery tests and remove obsolete workaround code rather than adding a second path.

## Confinement and platform notes

Keep descriptor-relative traversal and existing no-follow protections for both the staging file and destination. Path-string concatenation must not bypass them.

Observed platform papercut: `OsFileSystem` rejects a symlink even at the configured root (`rootDescriptor` opens with `NOFOLLOW`). On macOS, `/tmp` is a symlink, so the integration tests use `/private/tmp`; GNU/Linux tests use `/tmp`. This is a documented test-fixture issue, not a request to loosen symlink safety.

The inspected native filesystem module selects Darwin AArch64 and GNU/Linux AArch64/x86_64 profiles. Run native verification on supported available platforms and explicitly identify anything not exercised. Other providers must implement truthful semantics or explicitly reject unsupported capabilities.

## Acceptance criteria

1. **Existing-name safety:** exclusive creation cannot modify preexisting file bytes. Include existing directory and symlink cases.
2. **Concurrent claims:** two independent processes targeting the same new filename cannot both win; the winner's data is intact.
3. **Complete publication:** real native readers observe only complete old/new payloads during repeated atomic replacements. Do not substitute source inspection or mocked call counts for this boundary test.
4. **Pre-publication failures:** failures during staging, writing, or required pre-publication synchronization leave the destination unchanged; verify actual bytes and temporary-file cleanup behavior.
5. **Post-publication failures:** a simulated failure after namespace publication reports that publication happened; verify new destination bytes remain intact and callers can distinguish it from an untouched destination.
6. **No-replace publication:** an existing destination wins without data loss, including a controlled concurrent collision. No check-then-rename race.
7. **Confinement:** source/staging/destination operations cannot traverse forbidden symlinks or escape the provider root. Cover wrong entry kinds and failed cleanup without damaging unrelated paths.
8. **Metadata contract:** verify the specifically promised permission/metadata behavior of replacement and creation.
9. **Durability contract:** native sync operations execute and failures propagate. Verify ordering at the syscall/provider boundary where practical, but report the limit: unit tests and process termination do not prove physical power-loss recovery.
10. **Service completeness:** update every affected provider and fixture; preserve ordinary `writeFile` semantics. Unsupported providers must not claim atomicity or durability they cannot supply.
11. **Real consumer:** build this external package with the native compiler, exercise add/status/version/recover against a temporary project, and run its behavioral tests after any service changes.

## Existing consumer evidence and commands

This implementation session exercised:

- Independent random-named change files, ancestor discovery, highest-bump release, byte-preserving manifest edits, retained changelog history, and no-op repeated releases through the native CLI.
- A separate Silk package importing `changeset.Version` through a path dependency.
- Nine domain tests and three native filesystem fault-injection scenarios. The latter cover a partial existing-changelog write, a completed pending-file deletion followed by error, and a partial newly created changelog whose recovery must restore original absence.
- CLI recovery of an interrupted add and a release with a truncated live manifest.

Consumer test owner: `changes/src/tests/ReleaseCases.silk`. Its `InterruptedFileSystem` forwards operations to the real `OsFileSystem`, mutates real files, then injects a failure. It must be updated if the service contract changes.

Run from the Silk repository root with a native compiler built from this checkout:

```sh
silk build --manifest-path compiler/silk.toml --stdlib stdlib
silk test --manifest-path changes/silk.toml --root src/tests.silk --no-cache --stdlib stdlib
silk changes --dir changes status
```

Test discovery follows the selected root's imports; `changes/src/tests.silk` imports the package's test modules. Do not run `version` on the real repository as a verification fixture.

Native path dependencies are supported; the TypeScript bootstrap intentionally does not resolve them. For compiler-repository checks, derive the current focused commands from that repository rather than treating the consumer commands above as coverage of the new filesystem implementation.

## Scope boundaries

Required: exclusive regular-file claims, atomic whole-file publication, explicit synchronization/durability semantics, phase-aware failures, and provider/test/documentation updates.

Not required: monorepo versioning, publishing, filesystem watching, general advisory locking, arbitrary multi-file transactions, symlink-following convenience, or a new compiler intrinsic. Changeset migration can be a separate consumer change once the filesystem contract is implemented and verified.

## Consumer follow-up: tagged releases and history queries

Changeset now also commits one structured record per release at
`.changes/releases/<version>.toml`. These records retain migration notes and cumulative
prerelease changes; `since` queries rely on a complete predecessor chain. Do not treat this
directory as disposable cache or delete prerelease records after stable promotion.

The TOML records are authoritative; `CHANGELOG.md` is regenerated from them on each
new release and carries a visible generated-file warning. Existing Markdown is read
only for rollback backup, not used as release-history input. Recovery must still restore
the exact pre-operation Markdown bytes, including any manual edits. A missing migration
field in TOML means unspecified guidance; `since --json` continues to emit JSON with
`null` for that case.

The release transaction writes a new archive alongside the manifest/changelog updates.
Before `ready`, it records the archive filename with an empty directory under
`.changes/.lock/history/`. Rollback removes that uncommitted archive as well as restoring
the old release files. After `ready` is retired, cleanup must retain the committed archive.
Future atomic/durable integration must include publication of that record and synchronization
of the releases directory; single-file atomicity is still not a multi-file transaction.

The consumer suite includes SemVer, migration sections, history queries, tagged-release
lifecycles, lossless TOML serialization, and complete Markdown regeneration after archive
corrections or Markdown deletion. Real-filesystem rollback tests assert that recovery removes
the uncommitted TOML record and restores original Markdown bytes. The fixture provider
includes the newer filesystem service methods.
Use the repository's stdlib when running these tests:

```sh
silk test --manifest-path changes/silk.toml --root src/tests.silk --no-cache --stdlib stdlib
```
