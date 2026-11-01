#ifdef _WIN32
__declspec(dllimport) char ***__p__environ(void);
__declspec(dllimport) int _initialize_narrow_environment(void);
// Windows exposes its CRT environment through an accessor. A real C object owns the
// static read by Silk, preserving the external-static load contract on this platform.
char **silk_test_environment;
void silk_test_initialize_environment(void) {
  if (_initialize_narrow_environment() == 0) silk_test_environment = *__p__environ();
}
#endif
