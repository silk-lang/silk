__declspec(dllimport) void RaiseException(unsigned long, unsigned long,
                                        unsigned long, const unsigned long long *);
__declspec(dllimport) unsigned SetErrorMode(unsigned);
__declspec(dllimport) __declspec(noreturn) void ExitProcess(unsigned long);
void silk_guard(void);

void raise_foreign(void) { RaiseException(0xe0424242, 0, 0, 0); }

void mainCRTStartup(void) {
  // Suppress interactive crash dialogs only in this deliberately failing child.
  SetErrorMode(0x0001 | 0x0002);
  __try {
#ifdef UNGUARDED_CONTROL
    raise_foreign();
#else
    silk_guard();
#endif
  } __except (1) {
    ExitProcess(98);
  }
  ExitProcess(99);
}
