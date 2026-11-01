#include <float.h>
#include <stddef.h>
#include <stdarg.h>
#include <stdint.h>

static uint8_t storage[] = {42, 0};

uint8_t *silk_test_variadic_pointer(void) { return storage; }
const uint8_t *silk_test_variadic_many(void) { return storage; }

/* The consumer uses the platform's va_arg, not Silk's classification or lowering. */
int32_t silk_test_variadic_scalars(int32_t shape, ...) {
    va_list args;
    va_start(args, shape);
    int failed = 0;
#define EXPECT(type, expected) do { if (va_arg(args, type) != (expected)) failed = 1; } while (0)
    if (shape == 0) {
        EXPECT(int, -128);
        EXPECT(double, -1.25);
        EXPECT(int, 255);
        EXPECT(double, -2.5);
        EXPECT(int, -32768);
        EXPECT(uint8_t *, storage);
        EXPECT(int, 65535);
        EXPECT(const uint8_t *, storage);
        EXPECT(uint32_t, UINT32_C(4000000000));
        EXPECT(int64_t, INT64_C(-4294967297));
        EXPECT(uint64_t, UINT64_MAX);
        EXPECT(uint8_t *, NULL);
        EXPECT(int, 42);
        EXPECT(double, 0.5);
    } else if (shape == 1) {
        double positive_zero = va_arg(args, double);
        double negative_zero = va_arg(args, double);
        if (positive_zero != 0.0 || __builtin_signbit(positive_zero)) failed = 1;
        if (negative_zero != 0.0 || !__builtin_signbit(negative_zero)) failed = 1;
        EXPECT(double, 0x1p-149);
        EXPECT(double, (double)FLT_MAX);
        EXPECT(double, 0x1p-1074);
        EXPECT(double, DBL_MAX);
        double double_negative_zero = va_arg(args, double);
        if (double_negative_zero != 0.0 || !__builtin_signbit(double_negative_zero)) failed = 1;
        EXPECT(double, 0.0);
        EXPECT(double, -0.5);
    } else {
        failed = 1;
    }
#undef EXPECT
    va_end(args);
    return failed;
}
