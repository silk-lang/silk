#include <stdint.h>
#include <stddef.h>
int8_t silk_test_add_i8(int8_t a, int8_t b) { return (int8_t)(a + b); }
uint8_t silk_test_add_u8(uint8_t a, uint8_t b) { return (uint8_t)(a + b); }
int16_t silk_test_add_i16(int16_t a, int16_t b) { return (int16_t)(a + b); }
uint16_t silk_test_add_u16(uint16_t a, uint16_t b) { return (uint16_t)(a + b); }
int32_t silk_test_add_i32(int32_t a, int32_t b) { return a + b; }
uint32_t silk_test_add_u32(uint32_t a, uint32_t b) { return a + b; }
int64_t silk_test_add_i64(int64_t a, int64_t b) { return a + b; }
uint64_t silk_test_add_u64(uint64_t a, uint64_t b) { return a + b; }
intptr_t silk_test_add_isize(intptr_t a, intptr_t b) { return a + b; }
size_t silk_test_add_usize(size_t a, size_t b) { return a + b; }
float silk_test_scale_f32(float value, float factor) { return value * factor; }
double silk_test_scale_f64(double value, double factor) { return value * factor; }
static int32_t silk_test_counter = 0;
void silk_test_touch(void) { silk_test_counter += 1; }
int32_t silk_test_touched(void) { return silk_test_counter; }
