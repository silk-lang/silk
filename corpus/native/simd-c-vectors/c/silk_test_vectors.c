#include <stdint.h>
typedef float f32x4 __attribute__((vector_size(16)));
typedef uint8_t u8x16 __attribute__((vector_size(16)));
typedef int32_t i32x4 __attribute__((vector_size(16)));
typedef double f64x2 __attribute__((vector_size(16)));
i32x4 silk_test_vector_add(i32x4, i32x4);
f64x2 silk_test_vector_halve(f64x2);
f32x4 silk_test_vector_scale(f32x4 values, float factor) { return values * factor; }
u8x16 silk_test_vector_reverse(u8x16 values) {
  u8x16 reversed;
  for (int lane = 0; lane < 16; lane++) reversed[lane] = values[15 - lane];
  return reversed;
}
int32_t silk_test_vector_exports(void) {
  int32_t failures = 0;
  i32x4 a = {1, -2, 3, 40};
  i32x4 b = {10, 20, -30, 2};
  i32x4 sum = silk_test_vector_add(a, b);
  if (sum[0] != 11 || sum[1] != 18 || sum[2] != -27 || sum[3] != 42) failures += 1;
  f64x2 halves = silk_test_vector_halve((f64x2){9.0, -3.0});
  if (halves[0] != 4.5 || halves[1] != -1.5) failures += 2;
  return failures;
}
