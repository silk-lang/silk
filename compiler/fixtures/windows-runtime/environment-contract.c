// Independent OS-contract probe, not an implementation of the Silk provider.
// Build freestanding with Clang and link only Kernel32, as run-environment.ps1 does.
typedef unsigned short W;
typedef unsigned long D;
__declspec(dllimport) int __stdcall SetEnvironmentVariableW(const W *, const W *);
__declspec(dllimport) D __stdcall GetEnvironmentVariableW(const W *, W *, D);
__declspec(dllimport) W *__stdcall GetEnvironmentStringsW(void);
__declspec(dllimport) int __stdcall FreeEnvironmentStringsW(W *);
__declspec(dllimport) int __stdcall CompareStringOrdinal(const W *, int, const W *, int, int);
__declspec(dllimport) void __stdcall ExitProcess(D);

static int length(const W *s) { int n = 0; while (s[n]) ++n; return n; }
static int equal(const W *a, const W *b) {
  while (*a && *a == *b) { ++a; ++b; }
  return *a == *b;
}
static int snapshot_has(const W *block, const W *name, const W *value) {
  int n = length(name);
  for (const W *entry = block; *entry; entry += length(entry) + 1) {
    int i = 0;
    while (i < n && entry[i] == name[i]) ++i;
    if (i == n && entry[i] == '=' && equal(entry + i + 1, value)) return 1;
  }
  return 0;
}
static int check_case(const W *upper, const W *lower, int expected_equal) {
  const W value[] = {0xd800, 'x', 0xdc00, 0};
  W found[8] = {0};
  if (!SetEnvironmentVariableW(upper, value)) return 1;
  int compared = CompareStringOrdinal(upper, length(upper), lower, length(lower), 1);
  if (compared == 0 || (compared == 2) != expected_equal) return 2;
  D count = GetEnvironmentVariableW(lower, found, 8);
  if (expected_equal ? (count != 3 || !equal(found, value)) : count != 0) return 3;
  if (!SetEnvironmentVariableW(upper, (const W *)0)) return 4;
  return 0;
}
void mainCRTStartup(void) {
  // Non-ASCII simple case folding, ordinal no-expansion, and raw lone-surrogate values.
  const W upper[] = {'S','I','L','K','_','P','R','O','B','E','_',0xc9,0};
  const W lower[] = {'s','i','l','k','_','p','r','o','b','e','_',0xe9,0};
  const W sharp[] = {'S','I','L','K','_','P','R','O','B','E','_',0xdf,0};
  const W expanded[] = {'S','I','L','K','_','P','R','O','B','E','_','S','S',0};
  const W sigma[] = {'S','I','L','K','_','P','R','O','B','E','_',0x3a3,0};
  const W final_sigma[] = {'S','I','L','K','_','P','R','O','B','E','_',0x3c2,0};
  int result = check_case(upper, lower, 1);
  if (result) ExitProcess(10 + result);
  result = check_case(sharp, expanded, 0);
  if (result) ExitProcess(20 + result);
  result = check_case(sigma, final_sigma, 0);
  if (result) ExitProcess(30 + result);
  const W old[] = {'o','l','d',0};
  const W changed[] = {'n','e','w',0};
  if (!SetEnvironmentVariableW(upper, old)) ExitProcess(41);
  W *snapshot = GetEnvironmentStringsW();
  if (!snapshot) ExitProcess(42);
  if (!SetEnvironmentVariableW(upper, changed)) ExitProcess(43);
  int retained = snapshot_has(snapshot, upper, old);
  int freed = FreeEnvironmentStringsW(snapshot);
  if (!retained) ExitProcess(44);
  if (!freed) ExitProcess(45);
  ExitProcess(0);
}
