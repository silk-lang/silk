#include <stddef.h>
#include <stdbool.h>
#include <string.h>
#include <unistd.h>
#ifdef __APPLE__
#include <crt_externs.h>
#else
extern char **environ;
#endif

extern int main(int, char **);
_Static_assert(sizeof(int) == 4, "C main integer width");
static _Alignas(64) unsigned char arena[4 * 1024 * 1024];
static void *addresses[4096];
static void *snapshot_addresses[4096];
static size_t sizes[4096];
static size_t cursor;
static unsigned calls, count, refusal, invalid, bodies, drops, capture_calls, cwd_calls, snapshot_count;
static bool failing;
static char argument[] = "owned";
static char variable[] = "AUDIT=owned";
static char *environment[] = {variable, NULL};
static char *arguments[] = {(char *)"entry", argument, NULL};
static char *partial_arguments[] = {(char *)"entry", NULL};

static unsigned live_count(void) {
  unsigned result = 0;
  for (unsigned i = 0; i < count; ++i) result += addresses[i] != NULL;
  return result;
}

void *malloc(size_t size) {
  if (++calls == refusal) return NULL;
  size_t aligned = (cursor + 63) & ~(size_t)63;
  if (count == 4096 || aligned > sizeof arena || size > sizeof arena - aligned) {
    invalid = 10;
    return NULL;
  }
  void *address = arena + aligned;
  cursor = aligned + (size == 0 ? 1 : size);
  addresses[count] = address;
  sizes[count++] = size;
  return address;
}

void free(void *pointer) {
  if (pointer == NULL) return;
  for (unsigned i = 0; i < count; ++i) {
    if (addresses[i] == pointer) {
      memset(pointer, 0xDD, sizes[i]);
      addresses[i] = NULL;
      return;
    }
  }
  invalid = 11; /* A duplicate or foreign free is observable, never accepted. */
}

int audit_body(void) {
  ++bodies;
  capture_calls = calls;
  for (unsigned i = 0; i < count; ++i) {
    if (addresses[i] != NULL) snapshot_addresses[snapshot_count++] = addresses[i];
  }
  argument[0] = 'x';
  variable[6] = 'x';
  return failing ? 1 : 0;
}

void audit_drop(void) {
  ++drops;
  /* Error cleanup runs once while the lexical provider still owns its snapshot. */
  if (bodies != 1 || drops != 1 || snapshot_count == 0) invalid = 12;
  for (unsigned captured = 0; captured < snapshot_count; ++captured) {
    bool retained = false;
    for (unsigned i = 0; i < count; ++i) {
      if (addresses[i] == snapshot_addresses[captured]) retained = true;
    }
    if (!retained) invalid = 12;
  }
}

char *getcwd(char *buffer, size_t size) {
  const char *directory = ++cwd_calls == 1 ? "/before" : "/after";
  size_t length = strlen(directory) + 1;
  if (size < length) return NULL;
  memcpy(buffer, directory, length);
  return buffer;
}

static unsigned invoke(int argc, char **argv, unsigned fail_at, bool application_failure) {
  if (live_count() != 0) _exit(20);
  cursor = 0;
  calls = count = invalid = bodies = drops = capture_calls = cwd_calls = snapshot_count = 0;
  refusal = fail_at;
  failing = application_failure;
  argument[0] = 'o';
  variable[6] = 'o';
  int status = main(argc, argv);
  if (invalid != 0) _exit((int)invalid);
  if (live_count() != 0) _exit(21);
  if (fail_at != 0 || argc < 0 || argv == partial_arguments) {
    if (status != 1 || bodies != 0 || drops != 0) _exit(22);
    if (fail_at != 0 && calls != fail_at) _exit(23);
  } else {
    if (bodies != 1 || cwd_calls != 2) _exit(24);
    if (status != (application_failure ? 1 : 17)) _exit(25);
    if (drops != (application_failure ? 1u : 0u)) _exit(26);
  }
  return capture_calls;
}

/* Boundary fixture: call the real source C entry before CRT, then exit without another call. */
__attribute__((constructor)) static void cases(void) {
#ifdef __APPLE__
  *_NSGetEnviron() = environment;
#else
  environ = environment;
#endif
  unsigned allocations = invoke(2, arguments, 0, false);
  if (allocations == 0) _exit(27);
  (void)invoke(2, arguments, 0, true);
  (void)invoke(2, arguments, 0, true); /* A second failure must release an independent provider. */
  for (unsigned fail = 1; fail <= allocations; ++fail) {
    (void)invoke(2, arguments, fail, false);
  }
  (void)invoke(-1, arguments, 0, false);
  (void)invoke(2, partial_arguments, 0, false);
  _exit(42);
}
