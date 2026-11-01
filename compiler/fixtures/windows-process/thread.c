// Independent thread/wait ABI oracle. The Silk corpus remains the production integration proof.
#include <stdint.h>
#include <stddef.h>
typedef void *HANDLE;
typedef uint32_t D;
__declspec(dllimport) HANDLE CreateThread(void *, size_t, D (*)(void *), void *, D, D *);
__declspec(dllimport) D WaitForSingleObject(HANDLE, D);
__declspec(dllimport) int GetExitCodeThread(HANDLE, D *);
__declspec(dllimport) int CloseHandle(HANDLE);
__declspec(dllimport) D GetActiveProcessorCount(uint16_t);
__declspec(dllimport) D GetLastError(void);
__declspec(dllimport) int WaitOnAddress(volatile void *, void *, size_t, D);
__declspec(dllimport) void WakeByAddressSingle(void *);
__declspec(dllimport) void WakeByAddressAll(void *);
__declspec(dllimport) void ExitProcess(D);
static D ready, released, result;
static D start(void *argument) {
  if (argument != &result) return 9;
  __atomic_store_n(&ready, 1, __ATOMIC_RELEASE);
  WakeByAddressSingle(&ready);
  D zero = 0;
  while (__atomic_load_n(&released, __ATOMIC_ACQUIRE) == 0) {
    if (!WaitOnAddress(&released, &zero, sizeof(zero), 10000)) return 10;
  }
  result = 42;
  return 0x12345678;
}
void mainCRTStartup(void) {
  D expected = 1;
  if (!GetActiveProcessorCount(0xffff)) ExitProcess(1);
  // Compare mismatch wins even with zero timeout; equal value reports ERROR_TIMEOUT.
  if (!WaitOnAddress(&ready, &expected, sizeof(expected), 0)) ExitProcess(2);
  expected = 0;
  if (WaitOnAddress(&ready, &expected, sizeof(expected), 0) || GetLastError() != 1460) ExitProcess(3);
  HANDLE thread = CreateThread(0, 8388608, start, &result, 0x10000, 0);
  if (!thread) ExitProcess(4);
  while (__atomic_load_n(&ready, __ATOMIC_ACQUIRE) == 0) {
    if (!WaitOnAddress(&ready, &expected, sizeof(expected), 10000)) ExitProcess(5);
  }
  __atomic_store_n(&released, 1, __ATOMIC_RELEASE);
  WakeByAddressAll(&released);
  if (WaitForSingleObject(thread, 10000) != 0) ExitProcess(6);
  D code = 0;
  if (!GetExitCodeThread(thread, &code) || code != 0x12345678 || result != 42) ExitProcess(7);
  if (!CloseHandle(thread)) ExitProcess(8);
  ExitProcess(0);
}
