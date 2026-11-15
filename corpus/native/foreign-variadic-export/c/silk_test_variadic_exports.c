#include <stdint.h>

/* The Silk exports below are variadic C functions; this C caller passes their tails under the
 * platform's own C ABI, which puts them on the stack on Darwin ARM64 and in registers and then on
 * the stack on GNU ARM64 and System V x86-64. */
int32_t silk_test_configure(void *loop, int32_t option, ...);
int64_t silk_test_sum_variadic(int32_t count, ...);
double silk_test_sum_doubles(int32_t count, ...);
int32_t silk_test_mixed_variadic(int32_t tag, ...);

static uint8_t marker = 7;

uint8_t *silk_test_marker(void) { return &marker; }

int32_t silk_test_call_variadic_exports(void) {
    if (silk_test_configure(&marker, 0, 29) != 29) return 1;
    if (silk_test_configure(&marker, 1) != -1) return 2;
    /* Ten integers: more than the integer registers left on every admitted target. */
    if (silk_test_sum_variadic(10, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10) != 55) return 3;
    if (silk_test_sum_variadic(0) != 0) return 4;
    /* Ten doubles: more than the eight vector registers on System V and AAPCS. */
    if (silk_test_sum_doubles(10, 0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5, 9.5) != 50.0) return 5;
    signed char narrow = -3;
    short wide = 300;
    float single = 0.25f;
    if (silk_test_mixed_variadic(42, narrow, (int64_t)-5000000000LL, single, &marker, wide, (uint32_t)4000000000u,
            (int64_t)1, (int64_t)2, (int64_t)3, (int64_t)4, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, (int64_t)99) != 0) return 6;
    return 0;
}
