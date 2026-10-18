# Native entropy

`Random.fillBytes` borrows already initialized mutable bytes. Complete success means every byte
contains fresh secure provider output; memory initialization alone does not establish that claim.
`OsRandom.make` is stateless and makes no call. Empty fills make no call through either the public
wrapper or native provider. The native provider is selected only for Darwin ARM64 with system libc
and GNU Linux x86-64/ARM64 with GNU libc. Unsupported/no-libc profiles have no native provider member.
Portable scripted replacements and the secure derived operations remain ordinary source.

## Selected calls

Darwin calls `arc4random_buf(void *, size_t)` once for a nonempty range. Its return type is void;
there is no fabricated error result, errno check or readiness flag. Source makes no stronger
latency or no-wait promise than the selected libSystem call.

GNU calls `getrandom(void *, size_t, unsigned int)` with `GRND_NONBLOCK=1`, returning signed
pointer-width `ssize_t`. The selected targets use 64-bit size/count and 32-bit flags/error integers.
The admitted ABI requires glibc 2.25 and Linux 3.17 or later. Requests are capped at 256 bytes as
source policy. GRND_NONBLOCK rejects unready entropy with EAGAIN; it is not a wall-clock latency
bound. This size follows the documented small-request behavior while still checking every result.
[Linux man-pages 6.18, getrandom(2)](https://man7.org/linux/man-pages/man2/getrandom.2.html).

The exclusive borrow stays live throughout the operation. Source saves its raw pointer once and
forms offsets only within the same allocation. Positive counts no greater than the request advance
the committed prefix. EINTR retries the same position. Only a negative result reads the current
thread's errno, immediately before another call can overwrite it. Zero progress, excessive counts,
EAGAIN, ENOSYS, EPERM and all other failures cause the existing fatal trap.

## Partial output and failure

A successful partial native call can replace a prefix with fresh entropy while the initialized
tail retains its old bytes. A later failure does not roll the prefix back. The public provider
never returns that partial state as a successful secure fill or adds a typed failure channel.
There is no weak replacement, device/raw-syscall fallback, secret-byte logging or new public
uninitialized-storage API. Fatal traps do not promise resource cleanup.

## Verification

The JUL-133 supply/catalog records pin SDK 15.5, deployment 11.0, glibc 2.36/GCC12, LLVM22.1.8 and
exact selected headers. Separate C fixtures check signatures, scalar layout, flags and symbols.
Deterministic source/C receivers verify empty, split/short completion, retry offsets, partial
initialized tails and fatal outcomes in debug and optimized modes on all three native targets.
Darwin has no invented failure case. Required missing supplies/runners fail; LTO is rejected.
Actual random fill lives in the shared native corpus and asserts completion without distributions,
statistical thresholds, comparing two fills or printing random bytes.
