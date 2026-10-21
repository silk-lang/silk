// The calls `compiler/src/Profiler.silk` makes when Tracy is enabled. Silk cannot pass Tracy's
// C zone context by value yet, so a zone crosses the boundary packed into one word.
#include <stddef.h>
#include <stdint.h>

#include "tracy/TracyC.h"

uint64_t silk_tracy_zone_begin(const char *name, size_t size) {
  uint64_t location = ___tracy_alloc_srcloc_name(0, "silk", 4, name, size, name, size, 0);
  TracyCZoneCtx zone = ___tracy_emit_zone_begin_alloc(location, 1);
  return ((uint64_t)zone.id << 32) | (uint32_t)zone.active;
}

static TracyCZoneCtx unpack(uint64_t packed) {
  TracyCZoneCtx zone = {(uint32_t)(packed >> 32), (int32_t)(uint32_t)packed};
  return zone;
}

void silk_tracy_zone_end(uint64_t packed) { ___tracy_emit_zone_end(unpack(packed)); }

void silk_tracy_zone_text(uint64_t packed, const char *text, size_t size) {
  ___tracy_emit_zone_text(unpack(packed), text, size);
}
