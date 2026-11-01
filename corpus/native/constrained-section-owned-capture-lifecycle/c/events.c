#include <stdint.h>
#include "c-output.h"
void silk_record_event(int32_t value) { silk_test_integer(value); silk_test_character(','); }
int32_t silk_finish_events(void) { silk_test_line(""); return 42; }
