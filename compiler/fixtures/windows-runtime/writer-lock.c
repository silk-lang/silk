// Independent Win32 contract: recursive ownership lasts until the matching final release.
typedef unsigned long DWORD;
typedef void *HANDLE;
typedef struct { void *debug; long count, recursion; void *owner, *semaphore; unsigned long long spin; } CRITICAL_SECTION;
_Static_assert(sizeof(CRITICAL_SECTION) == 40, "Win64 CRITICAL_SECTION layout");
__declspec(dllimport) int InitOnceBeginInitialize(void *, DWORD, int *, void **);
__declspec(dllimport) int InitOnceComplete(void *, DWORD, void *);
__declspec(dllimport) int InitializeCriticalSectionEx(void *, DWORD, DWORD);
__declspec(dllimport) void EnterCriticalSection(void *);
__declspec(dllimport) void LeaveCriticalSection(void *);
__declspec(dllimport) int TryEnterCriticalSection(void *);
__declspec(dllimport) HANDLE CreateThread(void *, unsigned long long, DWORD (*)(void *), void *, DWORD, DWORD *);
__declspec(dllimport) DWORD WaitForSingleObject(HANDLE, DWORD);
__declspec(dllimport) int GetExitCodeThread(HANDLE, DWORD *);
__declspec(dllimport) int CloseHandle(HANDLE);
__declspec(dllimport) __declspec(noreturn) void ExitProcess(DWORD);
extern void *const __silk_stderr_once;
extern void *const __silk_stderr_lock;
static DWORD attempt(void *unused) {
  (void)unused;
  int pending = 0;
  if (!InitOnceBeginInitialize(__silk_stderr_once, 0, &pending, 0) || pending) return 9;
  int acquired = TryEnterCriticalSection(__silk_stderr_lock);
  if (acquired) LeaveCriticalSection(__silk_stderr_lock);
  return acquired ? 1 : 0;
}
static void check(DWORD expected) {
  HANDLE thread = CreateThread(0, 0, attempt, 0, 0, 0);
  DWORD result = 9;
  if (!thread || WaitForSingleObject(thread, 10000) != 0 ||
      !GetExitCodeThread(thread, &result) || !CloseHandle(thread)) ExitProcess(10);
  if (result != expected) ExitProcess(11 + expected);
}
void mainCRTStartup(void) {
  int pending = 0;
  if (!InitOnceBeginInitialize(__silk_stderr_once, 0, &pending, 0) || !pending) ExitProcess(1);
  if (!InitializeCriticalSectionEx(__silk_stderr_lock, 0, 0)) ExitProcess(2);
  if (!InitOnceComplete(__silk_stderr_once, 0, 0)) ExitProcess(3);
  EnterCriticalSection(__silk_stderr_lock);
  EnterCriticalSection(__silk_stderr_lock);
  check(0);
  LeaveCriticalSection(__silk_stderr_lock);
  check(0);
  LeaveCriticalSection(__silk_stderr_lock);
  check(1);
  ExitProcess(0);
}
