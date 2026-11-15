#include <stddef.h>
#include <stdint.h>
int32_t silk_test_apply(int32_t (*visit)(int32_t), int32_t value) { return visit(value); }
int32_t silk_test_apply_optional(int32_t (*visit)(int32_t), int32_t value) { return visit == NULL ? -1 : visit(value); }
int32_t silk_test_same(int32_t (*left)(int32_t), int32_t (*right)(int32_t)) { return left == right; }
void *silk_test_enter(void *(*entry)(void *), void *packet) { return entry(packet); }
struct silk_test_registration {
  int32_t (*visit)(int32_t);
  int32_t value;
};
int32_t silk_test_registered(struct silk_test_registration registration) { return registration.visit(registration.value); }
