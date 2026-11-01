
#if defined(_WIN32)
#include <stddef.h>
#include <stdint.h>
// Winsock ADDRINFOW and socket address layouts from the Windows SDK contracts.
// The stub replaces GetAddrInfoW/FreeAddrInfoW, while the production provider owns
// real WSAStartup/WSACleanup calls. No SDK or CRT is needed by this witness.
typedef uint16_t silk_native_char;
typedef int socklen_t;
struct sockaddr { uint16_t sa_family; char sa_data[14]; };
struct in_addr { uint32_t s_addr; };
struct in6_addr { unsigned char s6_addr[16]; };
struct sockaddr_in { uint16_t sin_family, sin_port; struct in_addr sin_addr; char zero[8]; };
struct sockaddr_in6 { uint16_t sin6_family, sin6_port; uint32_t flow; struct in6_addr sin6_addr; uint32_t scope; };
struct sockaddr_storage { uint16_t family; char padding[6]; uint64_t alignment; char tail[112]; };
struct addrinfo {
  int ai_flags, ai_family, ai_socktype, ai_protocol;
  size_t ai_addrlen;
  silk_native_char *ai_canonname;
  struct sockaddr *ai_addr;
  struct addrinfo *ai_next;
};
#define AF_UNSPEC 0
#define AF_INET 2
#define AF_INET6 23
#define SOCK_STREAM 1
#define IPPROTO_TCP 6
#define AI_NUMERICSERV 8
#define EAI_AGAIN 11002
#define EAI_FAMILY 10047
#define EAI_MEMORY 8
#define EAI_NONAME 11001
// Winsock returns the error directly and has no EAI_SYSTEM/errno pair.
#define EAI_SYSTEM 10014
#define EIO 0
#define getaddrinfo GetAddrInfoW
#define freeaddrinfo FreeAddrInfoW
void *memset(void *, int, size_t);
static uint32_t htonl(uint32_t value) { return __builtin_bswap32(value); }
int GetAddrInfoW(const silk_native_char *, const silk_native_char *, const struct addrinfo *, struct addrinfo **);
void FreeAddrInfoW(struct addrinfo *);
#else
#include <arpa/inet.h>
#include <errno.h>
#include <netdb.h>
#include <stddef.h>
#include <string.h>
typedef char silk_native_char;
#endif

static int same_native_text(const silk_native_char *actual, const char *expected) {
  while (*expected && *actual == (unsigned char)*expected) { ++actual; ++expected; }
  return *actual == 0 && *expected == 0;
}

static int silk_mode = 0;
static int silk_calls = 0;
static int silk_frees = 0;
static int silk_arguments_ok = 0;
static int silk_deadline_check = 0;
static int silk_deadline_work = 0;
static int silk_deadline_registration = 0;
static int silk_deadline_registration_drop = 0;
static int silk_deadline_result_drop = 0;
static int silk_deadline_ready = 0;
static int silk_deadline_complete = 0;
static struct addrinfo silk_nodes[4];
static struct sockaddr_storage silk_addresses[4];

typedef int (*silk_getaddrinfo_signature)(
  const silk_native_char *, const silk_native_char *, const struct addrinfo *, struct addrinfo **
);
typedef void (*silk_freeaddrinfo_signature)(struct addrinfo *);
static silk_getaddrinfo_signature silk_getaddrinfo_typecheck = &getaddrinfo;
static silk_freeaddrinfo_signature silk_freeaddrinfo_typecheck = &freeaddrinfo;

_Static_assert(sizeof(socklen_t) == 4, "socklen_t width");
_Static_assert(sizeof(struct sockaddr_in) == 16, "sockaddr_in width");
_Static_assert(offsetof(struct sockaddr_in, sin_addr) == 4, "sockaddr_in address offset");
_Static_assert(sizeof(struct sockaddr_in6) == 28, "sockaddr_in6 width");
_Static_assert(offsetof(struct sockaddr_in6, sin6_addr) == 8, "sockaddr_in6 address offset");
_Static_assert(sizeof(struct addrinfo) == 48, "addrinfo width");
_Static_assert(_Alignof(struct addrinfo) == 8, "addrinfo alignment");
#if defined(_WIN32)
_Static_assert(sizeof(((struct addrinfo *)0)->ai_addrlen) == 8, "Winsock size_t addrlen");
_Static_assert(offsetof(struct addrinfo, ai_addrlen) == 16, "Winsock addrlen offset");
_Static_assert(offsetof(struct addrinfo, ai_canonname) == 24, "Winsock canonname offset");
_Static_assert(offsetof(struct addrinfo, ai_addr) == 32, "Winsock address offset");
_Static_assert(offsetof(struct addrinfo, ai_next) == 40, "Winsock next offset");
#elif defined(__APPLE__)
_Static_assert(offsetof(struct addrinfo, ai_addrlen) == 16, "Darwin addrlen offset");
_Static_assert(offsetof(struct addrinfo, ai_canonname) == 24, "Darwin canonname offset");
_Static_assert(offsetof(struct addrinfo, ai_addr) == 32, "Darwin address offset");
_Static_assert(offsetof(struct addrinfo, ai_next) == 40, "Darwin next offset");
_Static_assert(AF_INET6 == 30, "Darwin AF_INET6");
_Static_assert(AI_NUMERICSERV == 4096, "Darwin AI_NUMERICSERV");
_Static_assert(EAI_AGAIN == 2 && EAI_FAMILY == 5 && EAI_MEMORY == 6 && EAI_NONAME == 8 && EAI_SYSTEM == 11, "Darwin EAI values");
#else
_Static_assert(offsetof(struct addrinfo, ai_addrlen) == 16, "GNU addrlen offset");
_Static_assert(offsetof(struct addrinfo, ai_addr) == 24, "GNU address offset");
_Static_assert(offsetof(struct addrinfo, ai_canonname) == 32, "GNU canonname offset");
_Static_assert(offsetof(struct addrinfo, ai_next) == 40, "GNU next offset");
_Static_assert(AF_INET6 == 10, "GNU AF_INET6");
_Static_assert(AI_NUMERICSERV == 1024, "GNU AI_NUMERICSERV");
_Static_assert(EAI_AGAIN == -3 && EAI_FAMILY == -6 && EAI_MEMORY == -10 && EAI_NONAME == -2 && EAI_SYSTEM == -11, "GNU EAI values");
#endif
_Static_assert(AF_INET == 2, "AF_INET");
_Static_assert(SOCK_STREAM == 1, "SOCK_STREAM");
_Static_assert(IPPROTO_TCP == 6, "IPPROTO_TCP");

void silk_resolver_stub_reset(int mode) {
  silk_mode = mode;
  silk_calls = 0;
  silk_frees = 0;
  silk_arguments_ok = 0;
  memset(silk_nodes, 0, sizeof(silk_nodes));
  memset(silk_addresses, 0, sizeof(silk_addresses));
}

int silk_resolver_stub_calls(void) { return silk_calls; }
int silk_resolver_stub_frees(void) { return silk_frees; }
int silk_resolver_stub_arguments_ok(void) { return silk_arguments_ok; }
int silk_resolver_stub_eai_system(void) { return EAI_SYSTEM; }
int silk_resolver_stub_errno_value(void) { return EIO; }

void silk_deadline_stub_reset(void) {
  silk_deadline_check = 0;
  silk_deadline_work = 0;
  silk_deadline_registration = 0;
  silk_deadline_registration_drop = 0;
  silk_deadline_result_drop = 0;
  silk_deadline_ready = 0;
  silk_deadline_complete = 0;
}
void silk_deadline_stub_mark_check(void) { silk_deadline_check += 1; }
void silk_deadline_stub_mark_work(void) { silk_deadline_work += 1; }
void silk_deadline_stub_mark_registration(void) { silk_deadline_registration += 1; }
void silk_deadline_stub_mark_registration_drop(void) { silk_deadline_registration_drop += 1; }
void silk_deadline_stub_mark_result_drop(void) { silk_deadline_result_drop += 1; }
void silk_deadline_stub_mark_ready(void) { silk_deadline_ready += 1; }
void silk_deadline_stub_mark_complete(void) { silk_deadline_complete += 1; }
int silk_deadline_stub_snapshot(void) {
  return silk_deadline_check * 10000000
    + silk_deadline_work * 1000000
    + silk_deadline_registration * 100000
    + silk_deadline_registration_drop * 10000
    + silk_deadline_result_drop * 1000
    + silk_deadline_ready * 100
    + silk_deadline_complete * 10;
}

static void silk_address(size_t index, unsigned last) {
  struct sockaddr_in *address = (struct sockaddr_in *)&silk_addresses[index];
  address->sin_family = AF_INET;
  address->sin_addr.s_addr = htonl(0xc0000200u + last);
  silk_nodes[index].ai_family = AF_INET;
  silk_nodes[index].ai_socktype = SOCK_STREAM;
  silk_nodes[index].ai_protocol = IPPROTO_TCP;
  silk_nodes[index].ai_addrlen = (socklen_t)sizeof(struct sockaddr_in);
  silk_nodes[index].ai_addr = (struct sockaddr *)address;
}

static void silk_address6(size_t index, unsigned last) {
  struct sockaddr_in6 *address = (struct sockaddr_in6 *)&silk_addresses[index];
  address->sin6_family = AF_INET6;
  address->sin6_addr.s6_addr[0] = 0x20;
  address->sin6_addr.s6_addr[1] = 0x01;
  address->sin6_addr.s6_addr[2] = 0x0d;
  address->sin6_addr.s6_addr[3] = 0xb8;
  address->sin6_addr.s6_addr[15] = (unsigned char)last;
  silk_nodes[index].ai_family = AF_INET6;
  silk_nodes[index].ai_socktype = SOCK_STREAM;
  silk_nodes[index].ai_protocol = IPPROTO_TCP;
  silk_nodes[index].ai_addrlen = (socklen_t)sizeof(struct sockaddr_in6);
  silk_nodes[index].ai_addr = (struct sockaddr *)address;
}

int getaddrinfo(
  const silk_native_char *node,
  const silk_native_char *service,
  const struct addrinfo *hints,
  struct addrinfo **result
) {
  silk_calls += 1;
  int expected_family = silk_mode == 11 ? AF_INET : (silk_mode == 12 ? AF_INET6 : AF_UNSPEC);
  silk_arguments_ok = node != NULL && same_native_text(node, "intranet")
    && service != NULL && same_native_text(service, "443")
    && hints != NULL && hints->ai_family == expected_family
    && hints->ai_socktype == SOCK_STREAM && hints->ai_protocol == IPPROTO_TCP
    && (hints->ai_flags & AI_NUMERICSERV) != 0 && result != NULL;
  if (silk_mode == 3) {
#if !defined(_WIN32)
    errno = EIO;
#endif
    return EAI_SYSTEM;
  }
  if (silk_mode == 7) return EAI_NONAME;
  if (silk_mode == 8) return EAI_AGAIN;
  if (silk_mode == 9) return EAI_FAMILY;
  if (silk_mode == 10) return EAI_MEMORY;
  if (silk_mode == 13) return 31337;
  if (silk_mode == 6) {
    *result = NULL;
    return 0;
  }
  if (silk_mode == 4) {
    silk_address(0, 1);
    silk_nodes[0].ai_family = 31337;
    *result = &silk_nodes[0];
    return 0;
  }
  if (silk_mode == 5) {
    silk_address(0, 1);
    silk_nodes[0].ai_addr = NULL;
    *result = &silk_nodes[0];
    return 0;
  }
  if (silk_mode == 11) {
    silk_address6(0, 1);
    silk_address(1, 2);
    silk_nodes[0].ai_next = &silk_nodes[1];
    *result = &silk_nodes[0];
    return 0;
  }
  if (silk_mode == 12) {
    silk_address(0, 1);
    silk_address6(1, 2);
    silk_nodes[0].ai_next = &silk_nodes[1];
    *result = &silk_nodes[0];
    return 0;
  }
  silk_address(0, 1);
  silk_address(1, silk_mode == 0 ? 1 : 2);
  silk_nodes[0].ai_next = &silk_nodes[1];
  if (silk_mode == 0) {
    silk_address(2, 2);
    silk_nodes[1].ai_next = &silk_nodes[2];
  }
  if (silk_mode == 1) {
    silk_nodes[1].ai_addrlen = 1;
  }
  if (silk_mode == 2) {
    silk_address(2, 3);
    silk_nodes[1].ai_next = &silk_nodes[2];
  }
  *result = &silk_nodes[0];
  return 0;
}

void freeaddrinfo(struct addrinfo *result) {
  if (result != NULL) silk_frees += 1;
}
