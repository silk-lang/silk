#include <stddef.h>
#include <stdint.h>
/* Fixture storage backs only small requests; huge valid alignments are refused by malloc.
 * Counting starts in the source main, after the hosted runtime's own allocations. */
_Alignas(max_align_t) static unsigned char arena[8 * 1024 * 1024];
static size_t used;
static int active, refuse, calls, frees, releases, live, invalid_release;
static size_t requested;
static void *ticket;
void *malloc(size_t size) {
  if (active) { calls++; requested = size; }
  if ((active && refuse) || used > sizeof(arena) - 32 || size > sizeof(arena) - used - 32) return NULL;
  used = (used + sizeof(size_t) + 15) & ~(size_t)15;
  void *result = arena + used;
  ((size_t *)result)[-1] = size;
  used += size ? size : 1;
  if (active) { ticket = result; live++; }
  return result;
}
void free(void *pointer) {
  if (!active) return;
  frees++;
  /* free(NULL) is inert and may disappear under optimization; it reclaims no ticket. */
  if (!pointer) return;
  releases++;
  if (pointer != ticket || live != 1) invalid_release++;
  else live--;
}
#ifdef _WIN32
// The Windows backend owns system storage through the process heap. Interpose that actual
// ABI rather than observing unrelated malloc calls. The header also lets runtime setup grow
// its buffers before counting begins; compiler allocation requests retain their exact size.
void *GetProcessHeap(void) { return arena; }
void *HeapAlloc(void *heap, uint32_t flags, size_t size) {
  (void)heap; (void)flags;
  return malloc(size);
}
int HeapFree(void *heap, uint32_t flags, void *pointer) {
  (void)heap; (void)flags;
  if (!pointer) { ++invalid_release; return 0; }
  free(pointer);
  return 1;
}
void *HeapReAlloc(void *heap, uint32_t flags, void *pointer, size_t size) {
  (void)heap; (void)flags;
  size_t previous = ((size_t *)pointer)[-1];
  unsigned char *next = malloc(size);
  if (!next) return NULL;
  size_t copy = previous < size ? previous : size;
  for (size_t at = 0; at < copy; ++at) next[at] = ((unsigned char *)pointer)[at];
  free(pointer);
  return next;
}
#endif
void silk_allocation_reset(int32_t should_refuse) {
  active = 1; refuse = should_refuse;
  calls = frees = releases = live = invalid_release = 0;
  requested = 0; ticket = NULL;
}
int32_t silk_allocation_check(size_t size, int32_t expected_calls, int32_t expected_releases, int32_t debug) {
#ifdef _WIN32
  /* HeapFree(NULL) is invalid, including in an unoptimized refusal cleanup. */
  int refusal_cleanup = frees == 0;
#else
  int refusal_cleanup = !debug || frees == 1;
#endif
  int32_t result = requested == size && calls == expected_calls &&
    releases == expected_releases &&
    (expected_calls == 0 ? frees == 0 : expected_releases == 0 || frees == expected_releases) &&
    (expected_calls != 1 || expected_releases != 0 || refusal_cleanup) &&
    live == 0 && invalid_release == 0 ? 42 : 0;
  active = 0;
  return result;
}
