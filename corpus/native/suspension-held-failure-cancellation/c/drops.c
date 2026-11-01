#include <stdint.h>
#include "c-output.h"
static char events[64];
static unsigned count;
void silk_record_drop(int32_t value) {
  if (count < sizeof(events) - 1) events[count++] = (char)('0' + value);
}
void silk_mark(int32_t value) {
  if (count < sizeof(events) - 1) events[count++] = (char)value;
}
int32_t silk_verify_drops(void) { silk_test_line(events); return 42; }
