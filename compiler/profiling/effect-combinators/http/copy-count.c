// Optional Linux profiling shim. Counts only out-of-line libc copies, not copies LLVM expands
// into loads/stores. Run separately from instruction/cache profiling. COPY_OUTPUT names a fresh
// 32-byte file containing four native-endian uint64 counters: memcpy calls/bytes, memmove calls/bytes.
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <unistd.h>

static void *(*next_copy)(void *, const void *, size_t);
static void *(*next_move)(void *, const void *, size_t);
static _Atomic uint64_t *counts;

__attribute__((constructor)) static void start_counting(void) {
    next_copy = dlsym(RTLD_NEXT, "memcpy");
    next_move = dlsym(RTLD_NEXT, "memmove");
    const char *path = getenv("COPY_OUTPUT");
    if (!path || !next_copy || !next_move) return;
    int fd = open(path, O_RDWR | O_CREAT | O_TRUNC, 0600);
    if (fd < 0) return;
    if (ftruncate(fd, 32) == 0) {
        void *mapping = mmap(NULL, 32, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
        if (mapping != MAP_FAILED) counts = mapping;
    }
    close(fd);
}

void *memcpy(void *destination, const void *source, size_t size) {
    if (counts) {
        atomic_fetch_add_explicit(&counts[0], 1, memory_order_relaxed);
        atomic_fetch_add_explicit(&counts[1], size, memory_order_relaxed);
    }
    if (next_copy) return next_copy(destination, source, size);
    volatile unsigned char *out = destination;
    const volatile unsigned char *in = source;
    for (size_t at = 0; at < size; at++) out[at] = in[at];
    return destination;
}

void *memmove(void *destination, const void *source, size_t size) {
    if (counts) {
        atomic_fetch_add_explicit(&counts[2], 1, memory_order_relaxed);
        atomic_fetch_add_explicit(&counts[3], size, memory_order_relaxed);
    }
    if (next_move) return next_move(destination, source, size);
    volatile unsigned char *out = destination;
    const volatile unsigned char *in = source;
    if ((uintptr_t)destination < (uintptr_t)source) {
        for (size_t at = 0; at < size; at++) out[at] = in[at];
    } else {
        for (size_t at = size; at != 0; at--) out[at - 1] = in[at - 1];
    }
    return destination;
}
