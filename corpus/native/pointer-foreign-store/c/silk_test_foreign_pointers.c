#include <stdint.h>
#include <stddef.h>
void silk_test_store(int32_t *out, int32_t value) { *out = value; }
void silk_test_fill(uint8_t *buffer, size_t length, uint8_t byte) {
  for (size_t index = 0; index < length; index += 1) buffer[index] = byte;
}
