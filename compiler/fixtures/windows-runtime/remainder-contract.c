// Independent native oracle: the production helper is compared against Windows' UCRT.
// Only this test dynamically loads UCRT; the helper has no imports or runtime dependency.
typedef unsigned long long U64;
typedef union { double value; U64 bits; } D;
typedef union { float value; unsigned bits; } F;
__declspec(dllimport) void *LoadLibraryW(const unsigned short *);
__declspec(dllimport) void *GetProcAddress(void *, const char *);
__declspec(dllimport) void ExitProcess(unsigned);
double fmod(double, double);
float fmodf(float, float);
int _fltused;

static int same64(double a, double b) {
  D x = {a}, y = {b};
  if ((x.bits & 0x7fffffffffffffffULL) > 0x7ff0000000000000ULL)
    return (y.bits & 0x7fffffffffffffffULL) > 0x7ff0000000000000ULL;
  return x.bits == y.bits;
}
static int same32(float a, float b) {
  F x = {a}, y = {b};
  if ((x.bits & 0x7fffffffU) > 0x7f800000U)
    return (y.bits & 0x7fffffffU) > 0x7f800000U;
  return x.bits == y.bits;
}
static U64 randomBits(U64 *state) {
  U64 x = *state;
  x ^= x << 13;
  x ^= x >> 7;
  x ^= x << 17;
  *state = x;
  return x;
}
void mainCRTStartup(void) {
  static const unsigned short name[] = {'u','c','r','t','b','a','s','e','.','d','l','l',0};
  void *library = LoadLibraryW(name);
  if (!library) ExitProcess(1);
  double (*reference64)(double, double) = (double (*)(double, double))GetProcAddress(library, "fmod");
  float (*reference32)(float, float) = (float (*)(float, float))GetProcAddress(library, "fmodf");
  if (!reference64 || !reference32) ExitProcess(2);
  static const U64 edges[] = {
    0, 0x8000000000000000ULL, 1, 0x000fffffffffffffULL,
    0x0010000000000000ULL, 0x3ff0000000000000ULL, 0x4008000000000000ULL,
    0x7fefffffffffffffULL, 0x7ff0000000000000ULL, 0x7ff8000000000001ULL,
    0xfff0000000000000ULL, 0xbff0000000000000ULL, 0x8000000000000001ULL
  };
  for (unsigned i = 0; i < sizeof(edges)/sizeof(edges[0]); ++i) {
    for (unsigned j = 0; j < sizeof(edges)/sizeof(edges[0]); ++j) {
      D a, b;
      a.bits = edges[i]; b.bits = edges[j];
      if (!same64(fmod(a.value, b.value), reference64(a.value, b.value))) ExitProcess(3);
      if (!same32(fmodf((float)a.value, (float)b.value), reference32((float)a.value, (float)b.value))) ExitProcess(4);
    }
  }
  U64 state = 0xfeb492c173a02e65ULL;
  for (unsigned i = 0; i < 20000; ++i) {
    D a, b; F c, d;
    a.bits = randomBits(&state); b.bits = randomBits(&state);
    c.bits = (unsigned)randomBits(&state); d.bits = (unsigned)randomBits(&state);
    if (!same64(fmod(a.value, b.value), reference64(a.value, b.value))) ExitProcess(5);
    if (!same32(fmodf(c.value, d.value), reference32(c.value, d.value))) ExitProcess(6);
  }
  ExitProcess(0);
}
