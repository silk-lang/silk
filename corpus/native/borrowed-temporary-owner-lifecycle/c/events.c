#include <stdint.h>
#include <stdio.h>
void silk_record_event(int32_t value) { printf("%d,", value); }
int32_t silk_finish_events(void) { puts(""); return 42; }
