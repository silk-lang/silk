#include <stdint.h>
int32_t silk_test_double_v1(int32_t);
int32_t silk_test_roundtrip(int32_t value) { return silk_test_double_v1(value) + 1; }
