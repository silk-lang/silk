// Corpus launcher: give the child an absent stderr handle while capturing its real exit code.
// Uses the original UTF-16 command tail so arguments retain CreateProcess/MSVC quoting.
typedef unsigned long DWORD;
typedef unsigned short WCHAR;
typedef void *HANDLE;
typedef struct {
  DWORD size;
  WCHAR *reserved, *desktop, *title;
  DWORD x, y, width, height, columns, rows, fill, flags;
  unsigned short show, reservedBytes;
  unsigned char *reservedData;
  HANDLE input, output, error;
} STARTUP;
typedef struct { HANDLE process, thread; DWORD pid, tid; } PROCESS;
__declspec(dllimport) WCHAR *GetCommandLineW(void);
__declspec(dllimport) HANDLE GetStdHandle(DWORD);
__declspec(dllimport) HANDLE GetCurrentProcess(void);
__declspec(dllimport) int DuplicateHandle(HANDLE, HANDLE, HANDLE, HANDLE *, DWORD, int, DWORD);
__declspec(dllimport) int CreateProcessW(WCHAR *, WCHAR *, void *, void *, int, DWORD, void *, WCHAR *, STARTUP *, PROCESS *);
__declspec(dllimport) DWORD WaitForSingleObject(HANDLE, DWORD);
__declspec(dllimport) int GetExitCodeProcess(HANDLE, DWORD *);
__declspec(dllimport) int CloseHandle(HANDLE);
__declspec(dllimport) void ExitProcess(DWORD);

void mainCRTStartup(void) {
  WCHAR *tail = GetCommandLineW();
  if (*tail == '"') { ++tail; while (*tail && *tail != '"') ++tail; if (*tail) ++tail; }
  else { while (*tail && *tail != ' ' && *tail != '\t') ++tail; }
  while (*tail == ' ' || *tail == '\t') ++tail;
  if (!*tail) ExitProcess(125);
  STARTUP startup = {0};
  PROCESS child = {0};
  startup.size = sizeof(startup);
  startup.flags = 0x100; // STARTF_USESTDHANDLES; NULL stderr is deliberately absent.
  HANDLE self = GetCurrentProcess();
  if (!DuplicateHandle(self, GetStdHandle((DWORD)-10), self, &startup.input, 0, 1, 2) ||
      !DuplicateHandle(self, GetStdHandle((DWORD)-11), self, &startup.output, 0, 1, 2)) ExitProcess(125);
  if (!CreateProcessW(0, tail, 0, 0, 1, 0x08000000, 0, 0, &startup, &child)) ExitProcess(125);
  CloseHandle(startup.input);
  CloseHandle(startup.output);
  CloseHandle(child.thread);
  DWORD code = 125;
  if (WaitForSingleObject(child.process, (DWORD)-1) != 0 || !GetExitCodeProcess(child.process, &code)) ExitProcess(125);
  CloseHandle(child.process);
  ExitProcess(code);
}
