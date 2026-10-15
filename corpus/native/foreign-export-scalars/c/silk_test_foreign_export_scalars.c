#include <stdint.h>
#include <stddef.h>
int8_t silk_test_export_add_i8(int8_t, int8_t);
uint8_t silk_test_export_add_u8(uint8_t, uint8_t);
int16_t silk_test_export_add_i16(int16_t, int16_t);
uint16_t silk_test_export_add_u16(uint16_t, uint16_t);
int32_t silk_test_export_add_i32(int32_t, int32_t);
uint32_t silk_test_export_add_u32(uint32_t, uint32_t);
int64_t silk_test_export_add_i64(int64_t, int64_t);
uint64_t silk_test_export_add_u64(uint64_t, uint64_t);
intptr_t silk_test_export_add_isize(intptr_t, intptr_t);
size_t silk_test_export_add_usize(size_t, size_t);
float silk_test_export_scale_f32(float, float);
double silk_test_export_scale_f64(double, double);
void silk_test_export_touch(void);
int32_t silk_test_export_touched(void);
static int32_t silk_test_export_counter = 0;
void silk_test_export_note(void) { silk_test_export_counter += 1; }
int32_t silk_test_export_noted(void) { return silk_test_export_counter; }
int32_t silk_test_export_checksum(void) {
  int32_t sum = 0;
  sum += silk_test_export_add_i8(-7, 3);
  sum += silk_test_export_add_u8(200, 5);
  sum += silk_test_export_add_i16(-300, 50);
  sum += silk_test_export_add_u16(60000, 7);
  sum += silk_test_export_add_i32(-11, 4);
  sum += (int32_t)silk_test_export_add_u32(9, 13);
  sum += (int32_t)silk_test_export_add_i64(-21, 6);
  sum += (int32_t)silk_test_export_add_u64(17, 23);
  sum += (int32_t)silk_test_export_add_isize(-5, 2);
  sum += (int32_t)silk_test_export_add_usize(8, 9);
  sum += (int32_t)silk_test_export_scale_f32(3.0f, 7.0f);
  sum += (int32_t)silk_test_export_scale_f64(-4.0, 5.0);
  silk_test_export_touch();
  silk_test_export_touch();
  silk_test_export_touch();
  sum += silk_test_export_touched() * 10;
  return ((sum % 256) + 256) % 256;
}
