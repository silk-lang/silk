#include <stdint.h>
#include "c-output.h"
static char events[16];
static unsigned count;
void silk_recovery_event(int32_t id) {
  silk_test_character('0' + id);
  if (count < sizeof(events) - 1) events[count++] = (char)('0' + id);
}
int32_t silk_recovery_verify(void) {
  silk_test_line("");
  return silk_test_equal(events, "7231") ? 42 : 0;
}
