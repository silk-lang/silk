// Independent child oracle: Shell32 argument parsing, Win32 environment, binary pipes and Job membership.
#include <stdint.h>
#include <stddef.h>
typedef void *H;
typedef uint16_t W;
typedef uint32_t D;
typedef struct { D size; W *reserved, *desktop, *title; D x,y,width,height,columns,rows,fill,flags;
  uint16_t show,reserved_count; uint8_t *reserved_bytes; H input,output,error; } STARTUP;
typedef struct { H process,thread; D pid,tid; } PROCESS;
typedef struct { int64_t process_time,job_time; D flags; size_t minimum,maximum; D processes;
  size_t affinity; D priority,scheduling; uint64_t io[6]; size_t process_memory,job_memory,peak_process,peak_job; } LIMITS;
typedef struct { size_t internal,high; uint64_t offset; H event; } OVERLAPPED;
_Static_assert(sizeof(STARTUP) == 104 && offsetof(STARTUP,input) == 80, "Win64 STARTUPINFO");
_Static_assert(sizeof(PROCESS) == 24 && sizeof(LIMITS) == 144 && sizeof(OVERLAPPED) == 32, "Win64 process layouts");
__declspec(dllimport) W *GetCommandLineW(void);
__declspec(dllimport) W **CommandLineToArgvW(const W *, int *);
__declspec(dllimport) H LocalFree(H);
__declspec(dllimport) D GetEnvironmentVariableW(const W *, W *, D);
__declspec(dllimport) H GetStdHandle(D);
__declspec(dllimport) int ReadFile(H, void *, D, D *, void *);
__declspec(dllimport) int WriteFile(H, const void *, D, D *, void *);
__declspec(dllimport) H GetCurrentProcess(void);
__declspec(dllimport) int IsProcessInJob(H, H, int *);
__declspec(dllimport) D GetModuleFileNameW(H, W *, D);
__declspec(dllimport) int CreateProcessW(const W *, W *, void *, void *, int, D, void *, const W *, STARTUP *, PROCESS *);
__declspec(dllimport) int CloseHandle(H);
__declspec(dllimport) void Sleep(D);
__declspec(dllimport) __declspec(noreturn) void ExitProcess(D);
static W executable[32768];
static uint8_t output[4096], errors[4096];
static int equal(const W *a, const W *b) { while (*a && *a == *b) { ++a; ++b; } return *a == *b; }
static void write_all(H handle, const void *bytes, D count) {
  const uint8_t *at = bytes;
  while (count) { D sent = 0; if (!WriteFile(handle, at, count, &sent, 0) || !sent || sent > count) ExitProcess(20);
    at += sent; count -= sent; }
}
void mainCRTStartup(void) {
  int count = 0;
  W **args = CommandLineToArgvW(GetCommandLineW(), &count);
  if (!args) ExitProcess(10);
  if (count == 2 && equal(args[1], (const W *)L"grandchild")) { for (;;) Sleep(60000); }
  const W surrogate[] = {0xd800,0}, quote[] = {'\\','"','\\',0};
  if (count != 5 || !equal(args[1], (const W *)L"a b") || args[2][0] ||
      !equal(args[3], surrogate) || !equal(args[4], quote)) ExitProcess(11);
  LocalFree(args);
  W value[32];
  if (GetEnvironmentVariableW((const W *)L"silk_\x00e9", value, 32) != 1 || value[0] != 0xd800) ExitProcess(12);
  if (GetEnvironmentVariableW((const W *)L"SILK_PARENT_ONLY", value, 32) != 0) ExitProcess(13);
  int in_job = 0;
  if (!IsProcessInJob(GetCurrentProcess(), 0, &in_job) || !in_job) ExitProcess(14);
  D received = 1; uint8_t byte = 99;
  if (!ReadFile(GetStdHandle((D)-10), &byte, 1, &received, 0) || received != 0) ExitProcess(15);
  if (!GetEnvironmentVariableW((const W *)L"SILK_TEST_STATUS", value, 32)) ExitProcess(16);
  if (equal(value, (const W *)L"259")) ExitProcess(259);
  if (equal(value, (const W *)L"high")) ExitProcess(0xc0000005UL);
  // A descendant retains the output pipes; successful provider return requires Job cleanup.
  if (!GetModuleFileNameW(0, executable, 32768)) ExitProcess(17);
  W command[] = L"fixture grandchild";
  STARTUP startup = {0}; startup.size = sizeof(startup); startup.flags = 0x100;
  startup.input = GetStdHandle((D)-10); startup.output = GetStdHandle((D)-11); startup.error = GetStdHandle((D)-12);
  PROCESS process = {0};
  if (!CreateProcessW(executable, command, 0, 0, 1, 0x08000000, 0, 0, &startup, &process)) ExitProcess(18);
  CloseHandle(process.thread); CloseHandle(process.process);
  for (D i=0; i<4096; ++i) { output[i] = (uint8_t)(i % 251); errors[i] = (uint8_t)(255 - i % 251); }
  for (D i=0; i<16; ++i) write_all(GetStdHandle((D)-11), output, sizeof(output));
  for (D i=0; i<16; ++i) write_all(GetStdHandle((D)-12), errors, sizeof(errors));
  ExitProcess(0);
}
