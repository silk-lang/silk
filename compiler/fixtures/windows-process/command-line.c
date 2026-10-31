// Independent OS oracle: Shell32 parses a command passed through actual CreateProcessW.
// This executable is test-only; Silk's production runtime does not import Shell32.
#include <stdint.h>
#include <stddef.h>
typedef void *HANDLE;
typedef uint16_t W;
typedef uint32_t D;
typedef struct {
  D size; W *reserved, *desktop, *title;
  D x, y, width, height, columns, rows, fill, flags;
  uint16_t show, reserved_count; uint8_t *reserved_bytes;
  HANDLE input, output, error;
} STARTUP;
typedef struct { HANDLE process, thread; D pid, tid; } PROCESS;
_Static_assert(sizeof(STARTUP) == 104, "STARTUPINFOW Win64 ABI");
_Static_assert(offsetof(STARTUP, input) == 80, "STARTUPINFOW handles");
_Static_assert(sizeof(PROCESS) == 24, "PROCESS_INFORMATION Win64 ABI");
__declspec(dllimport) W *GetCommandLineW(void);
__declspec(dllimport) D GetModuleFileNameW(HANDLE, W *, D);
__declspec(dllimport) int CreateProcessW(const W *, W *, void *, void *, int, D, void *, const W *, STARTUP *, PROCESS *);
__declspec(dllimport) D WaitForSingleObject(HANDLE, D);
__declspec(dllimport) int GetExitCodeProcess(HANDLE, D *);
__declspec(dllimport) int TerminateProcess(HANDLE, D);
__declspec(dllimport) int CloseHandle(HANDLE);
__declspec(dllimport) void ExitProcess(D);
__declspec(dllimport) W **CommandLineToArgvW(const W *, int *);
__declspec(dllimport) HANDLE LocalFree(HANDLE);

static int equal(const W *a, const W *b) {
  while (*a && *a == *b) { ++a; ++b; }
  return *a == *b;
}
// argv[0] retains its trailing slash; the later argument contains slash, quote, trailing slash.
static const W command[] = {
  '"','E',' ','\\','"',' ',
  '"','"',' ',
  '"','A',' ','B','"',' ',
  '"','\\','\\','\\','"','\\','\\','"',' ',
  '"',0xd800,'\t','\n','&','|','%','"',0
};
static W executable[32768], mutable_command[128];
static D launch(const W *line) {
  for (size_t i=0;;++i) { mutable_command[i]=line[i]; if (!line[i]) break; }
  STARTUP startup = {0}; startup.size = sizeof(startup);
  PROCESS child = {0};
  if (!CreateProcessW(executable, mutable_command, 0, 0, 0, 0x08000000, 0, 0, &startup, &child)) ExitProcess(10);
  D waited = WaitForSingleObject(child.process, 10000), status = 0;
  if (waited != 0) {
    TerminateProcess(child.process, 11);
    WaitForSingleObject(child.process, 10000);
    ExitProcess(11);
  }
  if (!GetExitCodeProcess(child.process, &status)) ExitProcess(12);
  if (!CloseHandle(child.thread) || !CloseHandle(child.process)) ExitProcess(13);
  return status;
}
void mainCRTStartup(void) {
  const W *raw = GetCommandLineW();
  if (equal(raw, command)) {
    int count = 0;
    W **args = CommandLineToArgvW(raw, &count);
    static const W slash_quote[] = {'\\','"','\\',0};
    static const W raw_units[] = {0xd800,'\t','\n','&','|','%',0};
    if (!args || count != 5 || !equal(args[0], (const W *)L"E \\") ||
        !equal(args[1], (const W *)L"") || !equal(args[2], (const W *)L"A B") ||
        !equal(args[3], slash_quote) || !equal(args[4], raw_units)) ExitProcess(21);
    LocalFree(args);
    // STILL_ACTIVE is also a legitimate user exit value after a completed wait.
    ExitProcess(259);
  }
  if (equal(raw, (const W *)L"explicit-status")) ExitProcess(0xc0000005u);
  D length = GetModuleFileNameW(0, executable, 32768);
  if (!length || length >= 32768) ExitProcess(1);
  if (launch(command) != 259) ExitProcess(2);
  // A high NTSTATUS-shaped code does not establish that the child crashed.
  if (launch((const W *)L"explicit-status") != 0xc0000005u) ExitProcess(3);
  ExitProcess(0);
}
