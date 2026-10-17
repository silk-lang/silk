#include <stdint.h>
#include <stdio.h>
static char events[32];
static unsigned count;
void silk_record_drop(int32_t value) {
  if (count < sizeof(events) - 1) events[count++] = (char)('0' + value);
}
int32_t silk_verify_drops(void) { puts(events); return 42; }
