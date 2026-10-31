// Independent Win32 contract checks and stdin setup for providers.silk. No SDK or CRT.
typedef unsigned long DWORD;
typedef unsigned long long SIZE_T;
typedef void *HANDLE;
typedef struct { DWORD low, high; } FILETIME;
typedef struct {
  unsigned short year, month, day_of_week, day, hour, minute, second, milliseconds;
} SYSTEMTIME;
_Static_assert(sizeof(HANDLE) == 8 && sizeof(DWORD) == 4 && sizeof(FILETIME) == 8, "Win64 layout");
_Static_assert(_Alignof(FILETIME) == 4, "FILETIME must not be cast to an aligned u64 pointer");
__declspec(dllimport) int QueryPerformanceCounter(long long *);
__declspec(dllimport) int QueryPerformanceFrequency(long long *);
__declspec(dllimport) void GetSystemTimePreciseAsFileTime(FILETIME *);
__declspec(dllimport) int SystemTimeToFileTime(const SYSTEMTIME *, FILETIME *);
__declspec(dllimport) int FileTimeToSystemTime(const FILETIME *, SYSTEMTIME *);
__declspec(dllimport) int ProcessPrng(unsigned char *, SIZE_T);
__declspec(dllimport) int CreatePipe(HANDLE *, HANDLE *, void *, DWORD);
__declspec(dllimport) int ReadFile(HANDLE, void *, DWORD, DWORD *, void *);
__declspec(dllimport) int WriteFile(HANDLE, const void *, DWORD, DWORD *, void *);
__declspec(dllimport) int CloseHandle(HANDLE);
__declspec(dllimport) HANDLE GetStdHandle(DWORD);
__declspec(dllimport) int SetStdHandle(DWORD, HANDLE);
__declspec(dllimport) DWORD GetLastError(void);
__declspec(dllimport) void Sleep(DWORD);
__declspec(dllimport) void ExitProcess(DWORD);

// Only this fixture owns these handles. Never close the process's inherited stdin.
static HANDLE owned_input;
int fixture_input(unsigned mode) {
  HANDLE read = 0, write = 0;
  if (owned_input) { CloseHandle(owned_input); owned_input = 0; }
  if (mode == 1) return SetStdHandle((DWORD)-10, 0);
  if (mode == 2) return SetStdHandle((DWORD)-10, (HANDLE)(SIZE_T)-1);
  if (!CreatePipe(&read, &write, 0, 0)) return 0;
  if (mode == 3) {
    CloseHandle(read);
    owned_input = write; // A real handle without read rights.
  } else {
    const unsigned char payload[] = {0, 255, 26, 10};
    DWORD written = 0;
    int ok = WriteFile(write, payload, sizeof payload, &written, 0);
    CloseHandle(write);
    if (!ok || written != sizeof payload) { CloseHandle(read); return 0; }
    owned_input = read;
  }
  return SetStdHandle((DWORD)-10, owned_input);
}

#ifndef SILK_PROVIDER_COMPANION
void mainCRTStartup(void) {
  long long frequency = 0, ticks = 0;
  if (!QueryPerformanceFrequency(&frequency) || frequency <= 0) ExitProcess(1);
  if (!QueryPerformanceCounter(&ticks) || ticks < 0) ExitProcess(2);
  FILETIME ft;
  SYSTEMTIME calendar;
  GetSystemTimePreciseAsFileTime(&ft);
  if (!FileTimeToSystemTime(&ft, &calendar)) ExitProcess(3);
  // Independently establish epoch units using Windows' calendar conversion, not Silk arithmetic.
  SYSTEMTIME epoch = {1970, 1, 0, 1, 0, 0, 0, 0};
  if (!SystemTimeToFileTime(&epoch, &ft)) ExitProcess(4);
  if (ft.high != 27111902UL || ft.low != 3577643008UL) ExitProcess(5);
  unsigned char bytes[34];
  bytes[0] = 37; bytes[33] = 91;
  if (!ProcessPrng(bytes + 1, 32) || bytes[0] != 37 || bytes[33] != 91) ExitProcess(6);
  // No entropy, uniqueness, elapsed-time, or probabilistic assertions.
  Sleep(0);
  if (!fixture_input(0)) ExitProcess(7);
  unsigned char buffer[8] = {0};
  DWORD count = 0;
  if (!ReadFile(GetStdHandle((DWORD)-10), buffer, 8, &count, 0)) ExitProcess(8);
  if (count != 4 || buffer[0] != 0 || buffer[1] != 255 || buffer[2] != 26 || buffer[3] != 10) ExitProcess(9);
  if (ReadFile(GetStdHandle((DWORD)-10), buffer, 8, &count, 0) || GetLastError() != 109) ExitProcess(10);
  if (!fixture_input(3)) ExitProcess(11);
  if (ReadFile(GetStdHandle((DWORD)-10), buffer, 8, &count, 0) || GetLastError() != 5) ExitProcess(12);
  if (!fixture_input(1) || GetStdHandle((DWORD)-10) != 0) ExitProcess(13);
  if (!fixture_input(2) || GetStdHandle((DWORD)-10) != (HANDLE)(SIZE_T)-1) ExitProcess(14);
  ExitProcess(0);
}
#endif
