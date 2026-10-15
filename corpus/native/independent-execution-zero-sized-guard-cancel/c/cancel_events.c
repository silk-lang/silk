#include <stdint.h>
#include <stdio.h>
#include <string.h>
static char events[32];
static unsigned count;
void silk_cancel_event(int32_t id) {
  putchar('0' + id);
  if (count < sizeof(events) - 1) events[count++] = (char)('0' + id);
}
int32_t silk_cancel_verify(void) {
  puts("");
  return strcmp(events, "2125") == 0 ? 42 : 0;
}
