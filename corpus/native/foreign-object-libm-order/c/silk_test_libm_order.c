#include <stdint.h>
#include <math.h>
int32_t silk_test_libm_order(double value) { return (int32_t)fmod(value, 43.0); }
