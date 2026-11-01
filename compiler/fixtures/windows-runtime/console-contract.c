// Read actual console cells after Silk writes them. No production implementation is supplied here.
typedef void *H;
typedef unsigned long D;
typedef unsigned short W;
typedef struct { short x, y; } COORD;
__declspec(dllimport) H GetStdHandle(D);
__declspec(dllimport) int SetStdHandle(D, H);
__declspec(dllimport) H CreateConsoleScreenBuffer(D, D, void *, D, void *);
__declspec(dllimport) int ReadConsoleOutputCharacterW(H, W *, D, COORD, D *);
__declspec(dllimport) int WriteConsoleW(H, const W *, D, D *, void *);
__declspec(dllimport) D GetConsoleOutputCP(void);
__declspec(dllimport) int GetConsoleMode(H, D *);
__declspec(dllimport) int CloseHandle(H);
static H original, screen;
static D code_page;
int fixture_console_begin(void) {
  original = GetStdHandle((D)-11);
  code_page = GetConsoleOutputCP();
  if (!code_page) return 0;
  screen = CreateConsoleScreenBuffer(0xc0000000UL, 3, 0, 1, 0);
  if (screen == (H)-1) return 0;
  if (!SetStdHandle((D)-11, screen)) { CloseHandle(screen); return 0; }
  return 1;
}
int fixture_console_end(void) {
  // Cell widths and surrogate presentation differ with the console host and font. Use the OS
  // rendering of independently specified UTF-16 as the oracle, rather than assuming one cell
  // per code unit. Silk must produce the same cells from its split canonical WTF-8 input.
  static const W expected_text[] = {'A', 0x20ac, 'B', 0xd83d, 0xdca9};
  W cells[16] = {0}, expected[16] = {0}; D count = 0, expected_count = 0, written = 0;
  H control = CreateConsoleScreenBuffer(0xc0000000UL, 3, 0, 1, 0);
  int good = control != (H)-1;
  if (good) {
    good = WriteConsoleW(control, expected_text, 5, &written, 0) && written == 5 &&
      ReadConsoleOutputCharacterW(control, expected, 16, (COORD){0,0}, &expected_count);
  }
  int read = ReadConsoleOutputCharacterW(screen, cells, 16, (COORD){0,0}, &count);
  if (control != (H)-1) good = CloseHandle(control) && good;
  int same_page = GetConsoleOutputCP() == code_page;
  D mode = 0;
  int ansi = GetConsoleMode(screen, &mode) && (mode & 5) == 5;
  int restored = SetStdHandle((D)-11, original);
  int closed = CloseHandle(screen);
  if (!good) return 10;
  if (!read) return 11;
  if (count != 16) return 12;
  if (expected_count != 16) return 13;
  if (!same_page) return 14;
  if (!restored) return 15;
  if (!closed) return 16;
  if (!ansi) return 17;
  // Preserve the actual and expected first differing UTF-16 cells in the process exit status.
  // This also works when the CI runner cannot capture a hidden console's output streams.
  for (D at = 0; at < 16; ++at)
    if (cells[at] != expected[at]) return (int)(((D)cells[at] << 16) | expected[at]);
  return 0;
}
