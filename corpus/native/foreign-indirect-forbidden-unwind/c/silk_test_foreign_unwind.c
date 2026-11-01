#include <stdint.h>
#ifdef _WIN32
__declspec(dllimport) void RaiseException(unsigned long, unsigned long, unsigned long, const uintptr_t *);
int32_t silk_test_raise_unwind(void) {
  RaiseException(0xe0424242, 0, 0, 0);
  return 0;
}
// Without Silk's guard the outer C handler catches the exception and returns normally.
int32_t silk_test_catch_unwind(int32_t (*entry)(void)) {
  __try { return entry(); }
  __except (1) { return 0; }
}
#ifdef SILK_UNWIND_CONTROL
__declspec(dllimport) void ExitProcess(unsigned long);
void mainCRTStartup(void) { ExitProcess(silk_test_catch_unwind(silk_test_raise_unwind)); }
#endif
#else
#include <string.h>
#include <unwind.h>

int32_t silk_test_raise_unwind(void) {
  struct _Unwind_Exception exception;
  memset(&exception, 0, sizeof(exception));
  exception.exception_class = UINT64_C(0x53494c4b54455354);
  _Unwind_RaiseException(&exception);
  return 0;
}
#endif

int32_t silk_test_invoke_callback(int32_t (*callback)(void)) {
  return callback();
}
