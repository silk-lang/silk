# Native clocks

The portable `SystemClock` and `MonotonicClock` services require explicit lexical providers. Native
`OsSystemClock` and `OsMonotonicClock` are stateless and make no call during construction. Their
members are selected only for Darwin ARM64 with system libc and GNU Linux x86-64/ARM64 with GNU
libc. Unsupported and no-libc profiles leave the native modules empty; portable replacements need
no native host import.

## Representation and outcomes

An Instant is signed i64 seconds plus i64 nanoseconds in [0, 1_000_000_000). System time measures
Unix-epoch civil time, permits negative seconds and can move backwards. Native monotonic time uses
CLOCK_MONOTONIC consistently, with nonnegative seconds and a provider-local origin. GNU excludes
system suspend time; Darwin includes it. Marks from different providers or clock domains are not
interchangeable deadlines.

Resolution is a positive u64 count of whole nanoseconds, describing nominal resolution rather than
measured precision. Failed reads, noncanonical fields, negative resolution components, zero or
unrepresentable resolution, invalid native deadlines and checked arithmetic overflow cause the
existing fatal trap. The public services have no typed failure channel. Construction never tests
availability by making a host call.

## Selected C boundary

The admitted Timespec is 16 bytes, aligned to 8, with signed 64-bit time_t seconds at offset 0 and
signed 64-bit long nanoseconds at offset 8. Darwin clockid_t is unsigned 32-bit with realtime 0 and
monotonic 6. GNU clockid_t is signed 32-bit with realtime 0 and monotonic 1. Ordinary selected source
owns these declarations; their names grant no compiler privilege. clock_gettime and clock_getres
return C int and write a noncaptured Timespec pointer. Failed reads do not consult errno because
all failures have the same fatal service outcome.

## Blocking waits

waitFor reads its starting mark once, computes one checked deadline with MonotonicClock.deadlineAfter,
and uses the same absolute policy as waitUntil. Fractional addition carries once; no arithmetic wraps.
A zero duration requires no positive timeline advance. Nonnegative past deadlines return without a
positive wait. Negative native deadlines are invalid even though the portable Instant can represent them.

GNU calls clock_nanosleep with CLOCK_MONOTONIC, TIMER_ABSTIME=1, the unchanged deadline and a null
remainder pointer. Direct status 0 succeeds and direct EINTR=4 retries. Other statuses trap.
The operation never reads errno; a stale error slot cannot change this decision.

Darwin reads CLOCK_MONOTONIC, returns if the deadline has been reached, otherwise computes the
positive remainder with fractional borrow and calls nanosleep with a null remainder pointer.
Success rereads the clock. Status -1 captures __error immediately; EINTR rereads the clock, while
other failures trap. Both retry paths recompute from the original deadline, accounting for elapsed
interruption handling and early returns without restarting the full duration.

These waits block the calling host thread. They do not promise Fiber cancellation or scheduler
progress. LocalScheduler's task-local clock retains its separate parking behavior and delegates
only its parent-clock operations according to that scheduler contract.

## Authority and verification

The JUL-132 OpenSpec supplies record pins Apple SDK 15.5, deployment 11.0, GNU glibc 2.36/GCC 12,
LLVM 22.1.8 and exact header hashes. Independent C fixtures check selected signatures, constants,
scalar signedness and record layout. Required debug/optimized source/C lanes execute on Darwin
ARM64 and GNU x86-64/ARM64; unavailable supplies are failures. LTO is rejected until separately
verified. Deterministic receivers prove error and deadline policy; real-clock correctness uses
semantic invariants without elapsed-time thresholds. Clock intrinsics, special reserved helpers
and generated clock fragments are not part of this boundary.
