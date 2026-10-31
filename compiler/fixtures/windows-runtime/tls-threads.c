/* A reduced loader proof. This is not a Silk runtime or executable. */
typedef void *HANDLE;
typedef unsigned long DWORD;
__declspec(dllimport) void ExitProcess(DWORD);
__declspec(dllimport) HANDLE CreateEventW(void *, int, int, const unsigned short *);
__declspec(dllimport) int SetEvent(HANDLE);
__declspec(dllimport) DWORD WaitForSingleObject(HANDLE, DWORD);
__declspec(dllimport) HANDLE CreateThread(void *, unsigned long long, DWORD (*)(void *), void *, DWORD, DWORD *);
__declspec(dllimport) int GetExitCodeThread(HANDLE, DWORD *);
__declspec(dllimport) int CloseHandle(HANDLE);
void *readDiagnostic(void);
void writeDiagnostic(void *);
void *readOther(void);
void writeOther(void *);
double floatDiagnostic(double, double);
double floatOther(double, double);

static HANDLE ready;
static HANDLE release;

static DWORD worker(void *unused) {
  int marker = 22;
  (void)unused;
  if (readOther() != 0) {
    SetEvent(ready);
    return 7;
  }
  writeOther(&marker);
  if (!SetEvent(ready)) return 8;
  if (WaitForSingleObject(release, 10000) != 0) return 9;
  return readDiagnostic() == &marker ? 0 : 10;
}

void mainCRTStartup(void) {
  int marker = 11;
  DWORD status = 99;
  if (readDiagnostic() != 0) ExitProcess(1);
  if (floatDiagnostic(1.25, 2.5) != 3.75 || floatOther(4.25, 5.5) != 9.75) ExitProcess(13);
  writeDiagnostic(&marker);
  ready = CreateEventW(0, 1, 0, 0);
  release = CreateEventW(0, 1, 0, 0);
  if (!ready || !release) ExitProcess(2);
  HANDLE thread = CreateThread(0, 0, worker, 0, 0, 0);
  if (!thread) ExitProcess(3);
  if (WaitForSingleObject(ready, 10000) != 0) ExitProcess(4);
  if (readOther() != &marker) ExitProcess(5);
  if (!SetEvent(release)) ExitProcess(6);
  if (WaitForSingleObject(thread, 10000) != 0 || !GetExitCodeThread(thread, &status)) ExitProcess(11);
  if (!CloseHandle(thread) || !CloseHandle(ready) || !CloseHandle(release)) ExitProcess(12);
  ExitProcess(status == 0 ? 0 : 10 + status);
}
