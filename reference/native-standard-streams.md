---
title: Native standard streams
description: Selected descriptor calls, borrowed process streams and source-owned transfer policy.
---

# Native standard streams

Native standard streams are ordinary source providers over selected libc declarations. Portable Writer and StandardInput services remain replaceable through lexical providers, including during suspension. No library spelling grants compiler privilege.

## Selected descriptor boundary

The initial catalog covers Darwin ARM64 with libSystem (SDK 15.5, deployment 11.0) and GNU x86-64/ARM64 with glibc 2.36. Descriptors and native errors are signed 32-bit integers. size_t and ssize_t are unsigned and signed pointer-width integers. read/write use explicit buffer pointers and counts; Darwin error state comes from __error and GNU error state from __errno_location. These synchronous calls do not retain their supplied buffer pointer. Error access remains conservatively ordered with external memory effects.

Catalog provenance is descriptive PlatformCatalog data: hand-authored declarations, exact pinned headers, target/deployment scope, separate constant/layout/signature/symbol claims, independent C fixtures and a reproducible drift-review procedure. Evidence is Planned until its actual result is recorded. Header or tool changes require reviewing the declarations and repeating the required conformance lanes. Unsupported and no-libc profiles do not expose native descriptor operations; portable services and ordinary replacements remain available.

## Output

A write commits all bytes or produces WriterError. The source loop advances only by positive actual progress, retries EINTR without advancing, fails on zero progress and reads native error state immediately after a negative return. Transfer requests are bounded by the conservative source policy 0x7ffff000; a return larger than the request is invalid. A later failure can follow a committed prefix. There is no rollback or whole-message retry.

An empty write succeeds without calling write or reading errno. Unbuffered stdout/stderr flush succeeds without a foreign operation. The providers borrow descriptors 1 and 2; they never close or release them.

Standard error has one process-wide recursive lock: the lock of the C library's `stderr` stream, taken with `flockfile` and released with `funlockfile` (`stderr` on GNU, `__stderrp` on Darwin). Each `StderrWriter` write holds it for that write. `StderrWriter.lock(buffer)` returns a `LockedStderr` that holds it until the drop and collects writes in the caller's buffer; a write that does not fit is sent together with the buffered bytes in one `writev`, and the drop writes the rest and ignores a failure. `StderrWriter.print` formats one message under the lock into a 64-byte stack buffer. The lock orders only writes that take it; a direct `NativeDescriptor` write to descriptor 2 does not. Standard output has no lock.

`Writer.writeVectored` on `StdoutWriter`, `StderrWriter`, and `LockedStderr` is `writev` through `NativeDescriptor.writeAllGather`: at most eight non-empty slices per system call, with partial writes resumed in the slice where they stopped. `StderrWriter` holds the lock for the whole vectored write. `LockedStderr` copies the slices when all fit in its free buffer, and otherwise sends the buffered bytes and the slices in one gather.

## Input

A nonempty read commits one actual transfer, retrying EINTR. Its positive count can be shorter than the buffer; bytes beyond the committed prefix retain their initialized values. Real native failure becomes StreamReadError after immediate native-error capture.

A zero-capacity request returns Filled(0), changes no bytes and performs no foreign call. It does not claim EOF, even if the provider has previously reached EOF. A zero result from an actual nonempty read latches EOF in that provider. Every later nonempty request returns EndOfInput without reading, preserving StandardInput's permanent-end contract. A newly constructed provider can observe a later descriptor state independently.

OsStandardInput borrows process descriptor 0. Construction initializes local state without reading; destruction never closes the descriptor. A provider replacement can implement a different byte source while honoring the same service outcome contract.

## Compiler boundary

No standard-stream intrinsic, HostWrite TIR/MIR operation, reserved stream import or generated stream adapter remains. Native objects name ordinary selected read/write/error symbols. Hosted reporting uses the ordinary NativeReport source writer over NativeDescriptor; it retains no generated report loop or standard-stream helper. Wasm receives no new host-stream provider.

## Required evidence

Pinned independent C fixtures verify all initial signatures, scalar layouts, constants and symbol names. Deterministic foreign-boundary fixtures distinguish interrupted/partial/zero-progress writes; empty operations; interrupted/short/failed reads; exact initialized prefixes and tails; zero-capacity reads; and permanent EOF latching. Existing shared native corpus cases prove real stdout/stderr and lexical/suspended provider behavior. Required debug/optimized native lanes compile, link, inspect and execute; absent supplies or skipped execution fail. LTO remains unsupported.

Native application edges import `silk.io.writer_native` and construct `StdoutWriter.make()` or `StderrWriter.make()`. Logging to standard error uses `silk.io.logger_native.StderrLogger.make()`, which writes `level: message` and a newline as one line under the standard error lock. Bare stdout logging uses `silk.io.logger_native.StdoutLogger.make()`. The portable Writer and Logger service modules do not import these native providers or require platform selection. Provider failures are constructed with ordinary `Writer.failure()` and `Logger.failure(code)` operations.
