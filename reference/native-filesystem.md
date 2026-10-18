# Native filesystem

The native FileSystem provider owns platform declarations, path policy and resources in ordinary
Silk source. It is selected for Darwin ARM64 with system libc and GNU Linux x86-64/ARM64 with GNU
libc. Other profiles have no native provider member; portable replacements remain usable on Wasm.

## Admitted calls and layout

The complete initial call set is open/openat, close, read/write, fstat/fstatat, ftruncate, mkdirat,
unlinkat, fdopendir, dirfd, readdir, closedir and the selected thread errno accessor. Open and openat
are genuinely variadic; creation supplies target mode_t through the C integer promotions. No
fixed-signature adapter stands in for them. ftruncate is used only after checking an opened write
destination is a regular file. No seek or fcntl API is admitted.

Counts and offsets are signed/unsigned 64-bit, descriptors and errors signed 32-bit. Darwin mode_t
is unsigned 16-bit, GNU unsigned 32-bit. stat is 144 bytes/alignment 8 on Darwin and GNU x86-64,
128 bytes/alignment 8 on GNU ARM64. Their mode and size offsets differ. GNU x86-64 O_DIRECTORY and
O_NOFOLLOW are 65536 and 131072; GNU ARM64 uses 16384 and 32768. Exact fields and constants belong
to independently compiled selected-header fixtures, not a presumed universal POSIX layout.

Nominal dirent sizes are 1048 on Darwin and 280 on GNU, alignment 8. The name starts at byte 21
on Darwin and 19 on GNU. A returned allocation need not span that nominal size. Source projects
its pointer to readonly bytes without loading a record, reads valid prefix fields and bounds the
name by reclen; Darwin namlen must agree with its terminating NUL. Each byte access requires valid,
initialized storage. A copied name outlives the next readdir; its borrowed original does not.

## Paths and confinement

OsFileSystem.make copies an absolute byte root and performs no I/O. The root must be nonempty
and NUL-free. Portable paths reject embedded NUL, dot/dot-dot and malformed normalized components.
Path.rawBytes and Path.joinBytes preserve byte identity, including directory names. The underlying
filesystem can still reject a byte name (for example, APFS rejects invalid UTF-8); that native
failure is reported. Text path helpers remain available for text callers. Each operation opens the configured root anew and traverses descriptors with
no-follow directory flags. The configured root and its ancestors are trusted. Symlinks below it
are rejected. This is not a guarantee against privileged mounts or hostile directory renames
across the root boundary.

## Resource and error policy

Every successful descriptor acquisition creates one affine source owner. fdopendir takes ownership
only on success. A directory stream owns its descriptor and closes through closedir exactly once.
Explicit consuming cleanup disarms first, attempts close once and never retries EINTR. Structured
cancellation and failure release remaining owners through source Drop. A primary failure survives
secondary cleanup failure; an otherwise successful operation reports its cleanup failure. Fatal
traps do not guarantee cleanup.

Capture errno immediately after a failed native call, before releasing names or descriptors.
Successful metadata with a wrong kind returns logical WrongType with code zero regardless of stale
errno. readdir requires clearing errno before its call: a null result then distinguishes EOF from
failure; a nonnull result does not read errno. Temporary native strings use the system allocator,
translating allocation failure to NoSpace; output bytes/lists use the caller allocator.

Read and write complete checked partial transfers, retry EINTR and reject invalid counts or zero
write progress. Empty transfers do not call the host. File writes check regular-file kind before
truncating. A later failure can leave a changed destination and does not promise rollback.
Directory enumeration owns a pending entry when the caller buffer is short; retry returns that
entry without calling readdir again. Full child byte paths are sorted by bytes.

Unique directory creation uses a provider-local wrapping u64 counter rendered as sixteen hex digits,
with at most 128 exclusive mkdirat attempts and mode 0700. Only collisions retry. Exhaustion returns
logical AlreadyExists with code zero. Names are predictable and independent of Random, clocks and
process IDs; exclusive creation establishes uniqueness.

## Evidence and updates

The JUL-131 catalog and supplies pin Apple SDK 15.5/deployment 11.0, glibc 2.36/GCC 12, LLVM 22.1.8
and exact header hashes. Changes require fresh independent C signature/layout/flag checks and source
receiver execution on all three targets in debug and optimized modes. Missing supplies/runners fail;
LTO is rejected. Fault fixtures cover transfer, cleanup, partial I/O, errors, short dirent storage,
byte paths and collision exhaustion; the shared native boundary harness retains real file effects.
