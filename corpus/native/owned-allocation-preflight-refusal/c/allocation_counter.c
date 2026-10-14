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
  used = (used + 15) & ~(size_t)15;
  void *result = arena + used;
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
void silk_allocation_reset(int32_t should_refuse) {
  active = 1; refuse = should_refuse;
  calls = frees = releases = live = invalid_release = 0;
  requested = 0; ticket = NULL;
}
int32_t silk_allocation_check(size_t size, int32_t expected_calls, int32_t expected_releases, int32_t debug) {
  int32_t result = requested == size && calls == expected_calls &&
    releases == expected_releases &&
    (expected_calls == 0 ? frees == 0 : expected_releases == 0 || frees == expected_releases) &&
    (!debug || expected_calls != 1 || expected_releases != 0 || frees == 1) &&
    live == 0 && invalid_release == 0 ? 42 : 0;
  active = 0;
  return result;
}
