#ifdef _WIN32
#include <stdint.h>
#include <stddef.h>
__declspec(dllimport) void *GetStdHandle(unsigned long);
__declspec(dllimport) int WriteFile(void *, const void *, unsigned long, unsigned long *, void *);
int64_t silk_test_write(int32_t descriptor, const void *bytes, size_t length) {
  unsigned long written = 0;
  if (descriptor != 1 || length > UINT32_MAX ||
      !WriteFile(GetStdHandle((unsigned long)-11), bytes, (unsigned long)length, &written, NULL)) return -1;
  return written;
}
#endif
