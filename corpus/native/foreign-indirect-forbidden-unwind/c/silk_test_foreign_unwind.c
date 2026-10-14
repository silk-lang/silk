#include <stdint.h>
#include <string.h>
#include <unwind.h>

int32_t silk_test_raise_unwind(void) {
  struct _Unwind_Exception exception;
  memset(&exception, 0, sizeof(exception));
  exception.exception_class = UINT64_C(0x53494c4b54455354);
  _Unwind_RaiseException(&exception);
  return 0;
}

int32_t silk_test_invoke_callback(int32_t (*callback)(void)) {
  return callback();
}
