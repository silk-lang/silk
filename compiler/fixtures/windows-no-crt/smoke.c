/* Freestanding Win64 declarations: no SDK headers or CRT startup. */
typedef unsigned long DWORD;
typedef unsigned long long SIZE_T;
typedef void *HANDLE;
__declspec(dllimport) HANDLE GetStdHandle(DWORD);
__declspec(dllimport) int WriteFile(HANDLE, const void *, DWORD, DWORD *, void *);
__declspec(dllimport) __declspec(noreturn) void ExitProcess(DWORD);
__declspec(dllimport) HANDLE GetProcessHeap(void);
__declspec(dllimport) void *HeapAlloc(HANDLE, DWORD, SIZE_T);
__declspec(dllimport) int HeapFree(HANDLE, DWORD, void *);
__declspec(dllimport) int WaitOnAddress(volatile void *, void *, SIZE_T, DWORD);
__declspec(dllimport) void WakeByAddressSingle(void *);
__declspec(dllimport) void WakeByAddressAll(void *);
int memcmp(const void *, const void *, SIZE_T);

/* Volatile loop prevents shrinking the frame to the two accessed endpoints. */
__declspec(noinline) unsigned large_frame(unsigned seed) {
  volatile unsigned char frame[32768];
  for (unsigned i = 0; i < sizeof(frame); ++i)
    frame[i] = (unsigned char)(seed + i);
  return frame[0] + frame[32767];
}

/* Keep the copy separate so optimization cannot replace it with another fill. */
__declspec(noinline) void copy(void *a, const void *b, SIZE_T size) {
  __builtin_memcpy(a, b, size);
}

/* Unknown lengths force LLVM's memory intrinsics to become external calls. */
__declspec(noinline) int memory(void *a, void *b, SIZE_T size) {
  __builtin_memset(a, 0x35, size);
  copy(b, a, size);
  __builtin_memmove((char *)b + 1, b, size - 1);
  return memcmp(a, b, size);
}

__declspec(noinline) double floating(double a, double b) { return a * b + 0.5; }

void mainCRTStartup(void) {
  HANDLE heap = GetProcessHeap();
  void *a = HeapAlloc(heap, 0, 4096);
  void *b = HeapAlloc(heap, 0, 4096);
  if (!a || !b) ExitProcess(1);
  if (memory(a, b, 4096) != 0) ExitProcess(2);
  if (large_frame(17) != 33) ExitProcess(3);
  if (floating(3.0, 2.0) != 6.5) ExitProcess(4);
  if (!HeapFree(heap, 0, a) || !HeapFree(heap, 0, b)) ExitProcess(5);
  unsigned value = 1, different = 2;
  if (!WaitOnAddress(&value, &different, sizeof(value), 0)) ExitProcess(6);
  WakeByAddressSingle(&value);
  WakeByAddressAll(&value);
  static const char message[] = "windows-no-crt: ok\n";
  DWORD written = 0;
  if (!WriteFile(GetStdHandle((DWORD)-11), message, sizeof(message) - 1,
                 &written, 0) || written != sizeof(message) - 1) ExitProcess(7);
  ExitProcess(0);
}
