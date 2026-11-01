// Independent Crypt32 enumeration; validates exact DER bytes without supplying Silk's results.
typedef unsigned int Dword;
typedef struct Context {
  Dword encoding;
  const unsigned char *bytes;
  Dword length;
  const void *information;
  void *store;
} Context;
_Static_assert(sizeof(Context) == 40 && __builtin_offsetof(Context, length) == 16,
               "Win64 CERT_CONTEXT layout");
__declspec(dllimport) void *CertOpenStore(const char *, Dword, void *, Dword, const void *);
__declspec(dllimport) int CertCloseStore(void *, Dword);
__declspec(dllimport) const Context *CertEnumCertificatesInStore(void *, const Context *);
__declspec(dllimport) Dword GetLastError(void);
static void *open_root(void) {
  static const unsigned short name[] = {'R', 'O', 'O', 'T', 0};
  return CertOpenStore((const char *)10, 0, 0, 0x1c000, name);
}
int fixture_root_count(void) {
  void *store = open_root();
  if (!store) return -1;
  int count = 0;
  const Context *context = 0;
  while ((context = CertEnumCertificatesInStore(store, context))) ++count;
  Dword error = GetLastError();
  if (!CertCloseStore(store, 2) || error != 0x80092004) return -2;
  return count;
}
int fixture_root_contains(const unsigned char *bytes, Dword length) {
  void *store = open_root();
  if (!store) return -1;
  int found = 0;
  const Context *context = 0;
  while ((context = CertEnumCertificatesInStore(store, context))) {
    if (context->length != length) continue;
    Dword i = 0;
    while (i < length && bytes[i] == context->bytes[i]) ++i;
    if (i == length) found = 1;
  }
  Dword error = GetLastError();
  if (!CertCloseStore(store, 2) || error != 0x80092004) return -2;
  return found;
}
