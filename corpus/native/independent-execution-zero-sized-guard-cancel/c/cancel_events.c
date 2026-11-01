#include <stdint.h>
#include "c-output.h"
static char events[32];
static unsigned count;
void silk_cancel_event(int32_t id) {
  silk_test_character('0' + id);
  if (count < sizeof(events) - 1) events[count++] = (char)('0' + id);
}
int32_t silk_cancel_verify(void) {
  silk_test_line("");
  return silk_test_equal(events, "2125") ? 42 : 0;
}
