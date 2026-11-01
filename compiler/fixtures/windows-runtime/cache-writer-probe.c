typedef unsigned long DWORD;
typedef unsigned short WCHAR;
typedef long long I64;
typedef void *HANDLE;
__declspec(dllimport) int __stdcall QueryPerformanceCounter(I64 *);
__declspec(dllimport) int __stdcall QueryPerformanceFrequency(I64 *);
__declspec(dllimport) DWORD __stdcall GetEnvironmentVariableW(const WCHAR *, WCHAR *, DWORD);
__declspec(dllimport) HANDLE __stdcall CreateFileW(const WCHAR *, DWORD, DWORD, void *, DWORD, DWORD, HANDLE);
__declspec(dllimport) int __stdcall WriteFile(HANDLE, const void *, DWORD, DWORD *, void *);
__declspec(dllimport) int __stdcall CloseHandle(HANDLE);
static I64 started;
void cache_probe_begin(void) { QueryPerformanceCounter(&started); }
static void number(char *buffer, unsigned *at, unsigned long long value) {
  if (value >= 10) number(buffer, at, value / 10);
  buffer[(*at)++] = (char)('0' + value % 10);
}
int cache_probe_phase(int phase) {
  I64 now, frequency;
  QueryPerformanceCounter(&now);
  QueryPerformanceFrequency(&frequency);
  WCHAR path[32768], mode[8];
  DWORD length = GetEnvironmentVariableW(L"SILK_CACHE_PROBE_LOG", path, 32768);
  if (length && length < 32768) {
    HANDLE file = CreateFileW(path, 4, 3, 0, 4, 128, 0);
    if (file != (HANDLE)-1) {
      char line[100]; unsigned at = 0; DWORD written;
      number(line, &at, (unsigned)phase); line[at++] = ' ';
      number(line, &at, (unsigned long long)((now - started) * 1000000 / frequency));
      line[at++] = '\n'; WriteFile(file, line, at, &written, 0); CloseHandle(file);
    }
  }
  return GetEnvironmentVariableW(L"SILK_CACHE_PROBE_RECONSTRUCT", mode, 8) > 0;
}
