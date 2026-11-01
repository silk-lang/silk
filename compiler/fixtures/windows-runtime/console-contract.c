// Read actual console cells after Silk writes them. No production implementation is supplied here.
typedef void *H;
typedef unsigned long D;
typedef unsigned short W;
typedef struct { short x, y; } COORD;
__declspec(dllimport) H GetStdHandle(D);
__declspec(dllimport) int SetStdHandle(D, H);
__declspec(dllimport) H CreateConsoleScreenBuffer(D, D, void *, D, void *);
__declspec(dllimport) int ReadConsoleOutputCharacterW(H, W *, D, COORD, D *);
__declspec(dllimport) D GetConsoleOutputCP(void);
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
  W cells[6] = {0}; D count = 0;
  int read = ReadConsoleOutputCharacterW(screen, cells, 6, (COORD){0,0}, &count);
  int same_page = GetConsoleOutputCP() == code_page;
  int restored = SetStdHandle((D)-11, original);
  int closed = CloseHandle(screen);
  return read && count == 6 && same_page && restored && closed &&
    cells[0] == 'A' && cells[1] == 0x20ac && cells[2] == 'B' &&
    cells[3] == 0xd83d && cells[4] == 0xdca9 && cells[5] == ' ';
}
