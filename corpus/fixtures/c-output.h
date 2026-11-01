// Independent byte output for the C lifecycle witnesses. No CRT initialization is required.
#include <stddef.h>
#include <stdint.h>
#ifdef _WIN32
__declspec(dllimport) void *GetStdHandle(unsigned long);
__declspec(dllimport) int WriteFile(void *, const void *, unsigned long, unsigned long *, void *);
static void silk_test_output(const char *bytes, size_t length) {
  while (length) {
    unsigned long count = 0;
    if (!WriteFile(GetStdHandle((unsigned long)-11), bytes, (unsigned long)length, &count, NULL) || !count)
      __builtin_trap();
    bytes += count; length -= count;
  }
}
#else
#include <unistd.h>
static void silk_test_output(const char *bytes, size_t length) {
  while (length) {
    ssize_t count = write(1, bytes, length);
    if (count <= 0) __builtin_trap();
    bytes += count; length -= (size_t)count;
  }
}
#endif
static void silk_test_character(int value) {
  char byte = (char)value;
  silk_test_output(&byte, 1);
}
static void silk_test_line(const char *text) {
  size_t length = 0;
  while (text[length]) ++length;
  silk_test_output(text, length);
  silk_test_character('\n');
}
static void silk_test_integer(int32_t value) {
  char digits[11];
  size_t used = sizeof(digits);
  uint32_t magnitude = value < 0 ? 0u - (uint32_t)value : (uint32_t)value;
  do { digits[--used] = (char)('0' + magnitude % 10); magnitude /= 10; } while (magnitude);
  if (value < 0) digits[--used] = '-';
  silk_test_output(digits + used, sizeof(digits) - used);
}
static int silk_test_equal(const char *left, const char *right) {
  while (*left && *left == *right) { ++left; ++right; }
  return *left == *right;
}
