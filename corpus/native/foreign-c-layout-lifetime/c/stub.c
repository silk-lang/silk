#include <stdint.h>
#include <stddef.h>
struct BufferRef { const uint8_t *data; size_t length; };
struct Descriptor { struct BufferRef label; uint32_t count; };
uint32_t c_sum(struct Descriptor d) { uint32_t s = 0; for (size_t i = 0; i < d.label.length; i++) s += d.label.data[i]; return s * d.count; }
uint32_t c_sum_at(const struct Descriptor *d) { return c_sum(*d) + 1; }
