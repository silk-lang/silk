#if defined(_WIN32)
#include <stddef.h>
#include <stdint.h>
typedef intptr_t silk_socket;
typedef int socklen_t;
typedef int ssize_t;
struct in_addr { uint32_t s_addr; };
struct sockaddr { uint16_t sa_family; char data[14]; };
struct sockaddr_in { uint16_t sin_family, sin_port; struct in_addr sin_addr; char zero[8]; };
#define AF_UNSPEC 0
#define AF_INET 2
#define SOCK_STREAM 1
#define IPPROTO_TCP 6
#define SOL_SOCKET 65535
#define SO_RCVTIMEO 4102
#define SO_SNDTIMEO 4101
#define SHUT_WR 1
#define INADDR_LOOPBACK 0x7f000001U
#define EINTR 10004
#define ECONNRESET 10054
__declspec(dllimport) int WSAStartup(unsigned short, void *);
__declspec(dllimport) int WSACleanup(void);
__declspec(dllimport) int WSAGetLastError(void);
__declspec(dllimport) silk_socket socket(int, int, int);
__declspec(dllimport) int bind(silk_socket, const struct sockaddr *, int);
__declspec(dllimport) int listen(silk_socket, int);
__declspec(dllimport) int connect(silk_socket, const struct sockaddr *, int);
__declspec(dllimport) int setsockopt(silk_socket, int, int, const void *, int);
__declspec(dllimport) int send(silk_socket, const void *, int, int);
__declspec(dllimport) int recv(silk_socket, void *, int, int);
__declspec(dllimport) int shutdown(silk_socket, int);
// Resolve the actual DLL functions while observing Silk's public accept/close calls.
// Importing their normal thunks would collide with the witness definitions in COFF.
__declspec(dllimport) void *GetModuleHandleW(const uint16_t *);
__declspec(dllimport) void *GetProcAddress(void *, const char *);
static void *winsock_function(const char *name) {
  static const uint16_t library[] = {'w','s','2','_','3','2','.','d','l','l',0};
  void *module = GetModuleHandleW(library);
  return module == NULL ? NULL : GetProcAddress(module, name);
}
void *memset(void *, int, size_t);
int memcmp(const void *, const void *, size_t);
static uint16_t htons(uint16_t value) { return __builtin_bswap16(value); }
static uint32_t htonl(uint32_t value) { return __builtin_bswap32(value); }
#define errno WSAGetLastError()
#define close closesocket
#define read(fd, buffer, length) recv(fd, buffer, (int)(length), 0)
#define write(fd, buffer, length) send(fd, buffer, (int)(length), 0)
int closesocket(silk_socket);
_Static_assert(sizeof(silk_socket) == 8 && sizeof(struct sockaddr_in) == 16, "Win64 socket address contract");
#else
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/syscall.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>
typedef int silk_socket;
#endif
#if defined(__APPLE__)
#include <dlfcn.h>
#include <stdarg.h>
#endif

static int silk_listener_http_active = 0;
static silk_socket silk_listener_http_accepted = -1;
static silk_socket silk_listener_http_listener = -1;
static int silk_listener_http_accepts = 0;
static int silk_listener_http_accepted_closes = 0;
static int silk_listener_http_listener_closes = 0;

static silk_socket silk_listener_http_admitted(silk_socket listener, silk_socket accepted) {
  if (silk_listener_http_active && accepted >= 0) {
    silk_listener_http_listener = listener;
    silk_listener_http_accepted = accepted;
    silk_listener_http_accepts += 1;
  }
  return accepted;
}

static void silk_listener_http_closed(silk_socket fd) {
  if (!silk_listener_http_active) return;
  if (fd == silk_listener_http_accepted) silk_listener_http_accepted_closes += 1;
  if (fd == silk_listener_http_listener) silk_listener_http_listener_closes += 1;
}

static int silk_listener_mode = 0;
static int silk_listener_sockets = 0;
static int silk_listener_binds = 0;
static int silk_listener_listens = 0;
static int silk_listener_getsocknames = 0;
static int silk_listener_accepts = 0;
static int silk_listener_polls = 0;
static int silk_listener_setsockopts = 0;
static int silk_listener_getsockopts = 0;
static int silk_listener_closes = 0;
static int silk_listener_closed_listener = 0;
static int silk_listener_closed_accepted = 0;
static int silk_listener_configuration_ok = 1;
static int silk_listener_wait_registrations = 0;
static int silk_listener_wake_releases = 0;
static int silk_listener_context_releases = 0;
static int silk_listener_completions = 0;
static int silk_listener_setup_order = 0;
static int silk_listener_domain = AF_UNSPEC;
static int silk_listener_fcntls = 0;

int silk_listener_loopback_available(void) {
#if defined(_WIN32)
  uint64_t data[51] = {0};
  if (WSAStartup(0x202, data) != 0) return 0;
#endif
#if defined(__linux__)
  int fd = (int)syscall(SYS_socket, AF_INET, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, IPPROTO_TCP);
#else
  silk_socket fd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
#endif
  if (fd < 0) {
#if defined(_WIN32)
    WSACleanup();
#endif
    return 0;
  }
  struct sockaddr_in address;
  memset(&address, 0, sizeof(address));
  address.sin_family = AF_INET;
  address.sin_port = htons(0);
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
#if defined(__linux__)
  int bound = (int)syscall(SYS_bind, fd, &address, sizeof(address));
  int listened = bound == 0 ? (int)syscall(SYS_listen, fd, 1) : -1;
  (void)syscall(SYS_close, fd);
#else
  int bound = bind(fd, (const struct sockaddr *)&address, sizeof(address));
  int listened = bound == 0 ? listen(fd, 1) : -1;
  (void)close(fd);
#endif
#if defined(_WIN32)
  WSACleanup();
#endif
  return bound == 0 && listened == 0 ? 1 : 0;
}

void silk_listener_stub_reset(int mode) {
  silk_listener_mode = mode;
  silk_listener_sockets = 0;
  silk_listener_binds = 0;
  silk_listener_listens = 0;
  silk_listener_getsocknames = 0;
  silk_listener_accepts = 0;
  silk_listener_polls = 0;
  silk_listener_setsockopts = 0;
  silk_listener_getsockopts = 0;
  silk_listener_closes = 0;
  silk_listener_closed_listener = 0;
  silk_listener_closed_accepted = 0;
  silk_listener_configuration_ok = 1;
  silk_listener_wait_registrations = 0;
  silk_listener_wake_releases = 0;
  silk_listener_context_releases = 0;
  silk_listener_completions = 0;
  silk_listener_setup_order = 0;
  silk_listener_domain = AF_UNSPEC;
  silk_listener_fcntls = 0;
}

int silk_listener_stub_sockets(void) { return silk_listener_sockets; }
int silk_listener_stub_binds(void) { return silk_listener_binds; }
int silk_listener_stub_listens(void) { return silk_listener_listens; }
int silk_listener_stub_getsocknames(void) { return silk_listener_getsocknames; }
int silk_listener_stub_accepts(void) { return silk_listener_accepts; }
int silk_listener_stub_polls(void) { return silk_listener_polls; }
int silk_listener_stub_setsockopts(void) { return silk_listener_setsockopts; }
int silk_listener_stub_getsockopts(void) { return silk_listener_getsockopts; }
int silk_listener_stub_close_attempts(void) { return silk_listener_closes; }
int silk_listener_stub_closed_listener(void) { return silk_listener_closed_listener; }
int silk_listener_stub_closed_accepted(void) { return silk_listener_closed_accepted; }
int silk_listener_stub_configuration_ok(void) { return silk_listener_configuration_ok; }
int silk_listener_stub_fcntls(void) { return silk_listener_fcntls; }
int silk_listener_stub_wait_registrations(void) { return silk_listener_wait_registrations; }
int silk_listener_stub_wake_releases(void) { return silk_listener_wake_releases; }
int silk_listener_stub_context_releases(void) { return silk_listener_context_releases; }
int silk_listener_stub_completions(void) { return silk_listener_completions; }
void silk_listener_stub_mark_wait_registration(void) { silk_listener_wait_registrations += 1; }
void silk_listener_stub_mark_wake_release(void) { silk_listener_wake_releases += 1; }
void silk_listener_stub_mark_context_release(void) { silk_listener_context_releases += 1; }
void silk_listener_stub_mark_completion(void) { silk_listener_completions += 1; }

#if defined(_WIN32)
silk_socket accept(silk_socket fd, void *address, int *length) {
  silk_socket (*real_accept)(silk_socket, void *, int *) = winsock_function("accept");
  if (real_accept == NULL) return -1;
  return silk_listener_http_admitted(fd, real_accept(fd, address, length));
}
int closesocket(silk_socket fd) {
  int (*real_close)(silk_socket) = winsock_function("closesocket");
  if (real_close == NULL) return -1;
  silk_listener_http_closed(fd);
  return real_close(fd);
}
#endif

#if defined(__linux__)
static int silk_listener_scripted(void) { return silk_listener_mode >= 100; }

int socket(int domain, int type, int protocol) {
  silk_listener_sockets += 1;
  if (!silk_listener_scripted()) return (int)syscall(SYS_socket, domain, type, protocol);
  if (silk_listener_setup_order != 0) silk_listener_configuration_ok = 0;
  silk_listener_setup_order = 1;
  silk_listener_domain = domain;
  if (silk_listener_mode == 125) { errno = ECONNREFUSED; return -1; }
  if (silk_listener_mode == 112) { errno = ENOMEM; return -1; }
  if (domain != AF_INET && domain != AF_INET6 && domain != AF_UNIX)
    silk_listener_configuration_ok = 0;
  if ((type & (SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC))
      != (SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC))
    silk_listener_configuration_ok = 0;
  if ((domain == AF_INET || domain == AF_INET6) && protocol != IPPROTO_TCP)
    silk_listener_configuration_ok = 0;
  if (domain == AF_UNIX && protocol != 0) silk_listener_configuration_ok = 0;
  return 40;
}

int bind(int fd, const struct sockaddr *address, socklen_t length) {
  silk_listener_binds += 1;
  if (!silk_listener_scripted()) return (int)syscall(SYS_bind, fd, address, length);
  if (silk_listener_setup_order != 1 && silk_listener_setup_order != 2)
    silk_listener_configuration_ok = 0;
  silk_listener_setup_order = 3;
  if (fd != 40 || address == NULL) silk_listener_configuration_ok = 0;
  if (address != NULL && address->sa_family == AF_INET && length != sizeof(struct sockaddr_in))
    silk_listener_configuration_ok = 0;
  if (address != NULL && address->sa_family == AF_INET6 && length != sizeof(struct sockaddr_in6))
    silk_listener_configuration_ok = 0;
  if (address != NULL && address->sa_family == AF_UNIX
      && (length < (socklen_t)(offsetof(struct sockaddr_un, sun_path) + 2)
        || length > sizeof(struct sockaddr_un)))
    silk_listener_configuration_ok = 0;
  if (silk_listener_mode == 126) { errno = ECONNREFUSED; return -1; }
  if (silk_listener_mode == 111) { errno = EADDRINUSE; return -1; }
  return 0;
}

int listen(int fd, int backlog) {
  silk_listener_listens += 1;
  if (!silk_listener_scripted()) return (int)syscall(SYS_listen, fd, backlog);
  if (silk_listener_setup_order != 3) silk_listener_configuration_ok = 0;
  silk_listener_setup_order = 4;
  int expected = silk_listener_mode == 113 ? 64 : 128;
  if (fd != 40 || backlog != expected) silk_listener_configuration_ok = 0;
  if (silk_listener_mode == 127) { errno = ECONNREFUSED; return -1; }
  if (silk_listener_mode == 114) { errno = EMFILE; return -1; }
  return 0;
}

static void silk_listener_fill_v4(
  struct sockaddr *address,
  socklen_t *length,
  uint16_t port,
  unsigned char last
) {
  struct sockaddr_in *value = (struct sockaddr_in *)address;
  memset(value, 0, sizeof(*value));
  value->sin_family = AF_INET;
  value->sin_port = htons(port);
  value->sin_addr.s_addr = htonl(0xc0000200u + last);
  *length = (socklen_t)sizeof(*value);
}

static void silk_listener_fill_v6(
  struct sockaddr *address,
  socklen_t *length,
  uint16_t port
) {
  struct sockaddr_in6 *value = (struct sockaddr_in6 *)address;
  memset(value, 0, sizeof(*value));
  value->sin6_family = AF_INET6;
  value->sin6_port = htons(port);
  value->sin6_addr = in6addr_loopback;
  *length = (socklen_t)sizeof(*value);
}

int getsockname(int fd, struct sockaddr *address, socklen_t *length) {
  silk_listener_getsocknames += 1;
  if (!silk_listener_scripted()) return (int)syscall(SYS_getsockname, fd, address, length);
  if (silk_listener_setup_order != 4) silk_listener_configuration_ok = 0;
  silk_listener_setup_order = 5;
  if (fd != 40 || address == NULL || length == NULL || *length != 128)
    silk_listener_configuration_ok = 0;
  if (silk_listener_mode == 128) { errno = -77; return -1; }
  if (silk_listener_mode == 115) { *length = 1; return 0; }
  if (silk_listener_mode == 130) {
    silk_listener_fill_v6(address, length, 43211);
    return 0;
  }
  silk_listener_fill_v4(address, length, 43210, 1);
  if (silk_listener_mode == 116) *length = 17;
  return 0;
}

int setsockopt(int fd, int level, int option, const void *value, socklen_t length) {
  if (!silk_listener_scripted())
    return (int)syscall(SYS_setsockopt, fd, level, option, value, length);
  silk_listener_setsockopts += 1;
  if (value == NULL || length != 4 && length != 8) silk_listener_configuration_ok = 0;
  if (fd == 40 && silk_listener_mode == 113) {
    if (level != SOL_SOCKET || option != SO_REUSEADDR || length != 4)
      silk_listener_configuration_ok = 0;
    errno = EACCES;
    return -1;
  }
  if (fd == 40) {
    if (silk_listener_setup_order != 1) silk_listener_configuration_ok = 0;
    silk_listener_setup_order = 2;
  }
  if (fd == 40 && silk_listener_mode == 130) {
    if (level != IPPROTO_IPV6 || option != IPV6_V6ONLY || length != 4
        || *(const int *)value != 1)
      silk_listener_configuration_ok = 0;
  }
  if (fd == 41 && option != SO_LINGER) silk_listener_configuration_ok = 0;
  if (silk_listener_mode == 117 && fd == 41) { errno = EIO; return -1; }
  return 0;
}

int accept4(int fd, struct sockaddr *address, socklen_t *length, int flags) {
  if (!silk_listener_scripted()) return silk_listener_http_admitted(fd,
    (int)syscall(SYS_accept4, fd, address, length, flags));
  silk_listener_accepts += 1;
  // Pathname Unix listeners keep their requested path, so only internet listeners ask getsockname.
  if (silk_listener_setup_order != (silk_listener_domain == AF_UNIX ? 4 : 5))
    silk_listener_configuration_ok = 0;
  if (fd != 40 || address == NULL || length == NULL || *length != 128
      || flags != (SOCK_NONBLOCK | SOCK_CLOEXEC))
    silk_listener_configuration_ok = 0;
  if (silk_listener_mode == 129) { errno = ECONNREFUSED; return -1; }
  if (silk_listener_mode == 105) { errno = EACCES; return -1; }
  if (silk_listener_mode == 102 && silk_listener_accepts == 1) { errno = EAGAIN; return -1; }
  if (silk_listener_mode == 131 && silk_listener_accepts <= 2) { errno = EAGAIN; return -1; }
  if (silk_listener_mode == 132 || silk_listener_mode == 133) { errno = EAGAIN; return -1; }
  if (silk_listener_mode == 103 && silk_listener_accepts == 1) { errno = EINTR; return -1; }
  if (silk_listener_mode == 104 && silk_listener_accepts == 1) { errno = ECONNABORTED; return -1; }
  if (silk_listener_mode >= 140 && silk_listener_mode <= 148
      && silk_listener_accepts == 1) {
    static const int pending_errors[] = {
      ECONNABORTED,
      ENETDOWN,
      EPROTO,
      ENOPROTOOPT,
      EHOSTDOWN,
      ENONET,
      EHOSTUNREACH,
      EOPNOTSUPP,
      ENETUNREACH,
    };
    errno = pending_errors[silk_listener_mode - 140];
    return -1;
  }
  if ((silk_listener_mode == 120 || silk_listener_mode == 121
      || silk_listener_mode == 122 || silk_listener_mode == 123)
      && silk_listener_accepts == 1) { errno = EAGAIN; return -1; }
  if (silk_listener_mode == 106) { *length = 1; return 41; }
  if (silk_listener_mode == 107) {
    memset(address, 0, 16);
    address->sa_family = (sa_family_t)31337;
    *length = 16;
    return 41;
  }
  if (silk_listener_mode == 108) {
    struct sockaddr_un *peer = (struct sockaddr_un *)address;
    memset(peer, 0, sizeof(*peer));
    peer->sun_family = AF_UNIX;
    peer->sun_path[0] = 0;
    *length = (socklen_t)(offsetof(struct sockaddr_un, sun_path) + 1);
    return 41;
  }
  if (silk_listener_mode == 109) {
    struct sockaddr_un *peer = (struct sockaddr_un *)address;
    memset(peer, 0, sizeof(*peer));
    peer->sun_family = AF_UNIX;
    *length = (socklen_t)offsetof(struct sockaddr_un, sun_path);
    return 41;
  }
  if (silk_listener_mode == 110) {
    struct sockaddr_un *peer = (struct sockaddr_un *)address;
    memset(peer, 0, sizeof(*peer));
    peer->sun_family = AF_UNIX;
    memcpy(peer->sun_path, "peer", 5);
    *length = (socklen_t)(offsetof(struct sockaddr_un, sun_path) + 5);
    return 41;
  }
  silk_listener_fill_v4(address, length, 1234, 9);
  return 41;
}

int poll(struct pollfd *fds, nfds_t count, int timeout) {
  if (!silk_listener_scripted()) {
    // ARM64 Linux has ppoll rather than the legacy poll syscall. Use it on every Linux host.
    struct timespec duration = { 0, 0 };
    if (timeout >= 0) {
      duration.tv_sec = timeout / 1000;
      duration.tv_nsec = (timeout % 1000) * 1000000L;
    }
    return (int)syscall(SYS_ppoll, fds, count, timeout < 0 ? NULL : &duration, NULL, (size_t)0);
  }
  silk_listener_polls += 1;
  if (fds == NULL || count != 1 || timeout != 0 || fds[0].fd != 40
      || fds[0].events != POLLIN)
    silk_listener_configuration_ok = 0;
  if (silk_listener_mode == 120 && silk_listener_polls == 1) { errno = EINTR; return -1; }
  if (silk_listener_mode == 132 || silk_listener_mode == 133) {
    fds[0].revents = 0;
    return 0;
  }
  if (silk_listener_mode == 121) { fds[0].revents = POLLNVAL; return 1; }
  if (silk_listener_mode == 122 || silk_listener_mode == 123) {
    fds[0].revents = POLLERR;
    return 1;
  }
  fds[0].revents = POLLIN;
  return 1;
}

int getsockopt(int fd, int level, int option, void *value, socklen_t *length) {
  if (!silk_listener_scripted())
    return (int)syscall(SYS_getsockopt, fd, level, option, value, length);
  silk_listener_getsockopts += 1;
  if (fd != 40 || level != SOL_SOCKET || option != SO_ERROR || value == NULL
      || length == NULL || *length < sizeof(int))
    silk_listener_configuration_ok = 0;
  if (silk_listener_mode == 123) { errno = EIO; return -1; }
  *(int *)value = EACCES;
  *length = sizeof(int);
  return 0;
}

int close(int fd) {
  if (!silk_listener_scripted()) {
    silk_listener_http_closed(fd);
    return (int)syscall(SYS_close, fd);
  }
  silk_listener_closes += 1;
  if (fd == 40) silk_listener_closed_listener += 1;
  if (fd == 41) silk_listener_closed_accepted += 1;
  if (((silk_listener_mode == 132 && fd == 40)
      || (silk_listener_mode == 134 && fd == 41))
      && silk_listener_wake_releases != 1)
    silk_listener_configuration_ok = 0;
  if (silk_listener_mode == 134 && fd == 41 && silk_listener_context_releases != 1)
    silk_listener_configuration_ok = 0;
  if (silk_listener_mode == 118 && fd == 40) { errno = EIO; return -1; }
  if (silk_listener_mode == 124 && fd == 41) { errno = EIO; return -1; }
  return 0;
}
#endif

#if defined(__APPLE__)
static int silk_listener_darwin_scripted(void) { return silk_listener_mode >= 200; }

int socket(int domain, int type, int protocol) {
  if (!silk_listener_darwin_scripted()) {
    static int (*real_socket)(int, int, int) = NULL;
    if (real_socket == NULL) real_socket = dlsym(RTLD_NEXT, "socket");
    return real_socket(domain, type, protocol);
  }
  silk_listener_sockets += 1;
  int expected_domain = silk_listener_mode == 203 ? AF_INET6 : AF_INET;
  if (domain != expected_domain || type != SOCK_STREAM || protocol != IPPROTO_TCP)
    silk_listener_configuration_ok = 0;
  silk_listener_setup_order = 1;
  return 40;
}

int fcntl(int fd, int command, ...) {
  va_list arguments;
  va_start(arguments, command);
  int argument = 0;
  if (command == F_SETFL || command == F_SETFD) argument = va_arg(arguments, int);
  va_end(arguments);
  if (!silk_listener_darwin_scripted()) {
    static int (*real_fcntl)(int, int, ...) = NULL;
    if (real_fcntl == NULL) real_fcntl = dlsym(RTLD_NEXT, "fcntl");
    if (command == F_SETFL || command == F_SETFD) return real_fcntl(fd, command, argument);
    return real_fcntl(fd, command);
  }
  silk_listener_fcntls += 1;
  int position = fd == 40 ? silk_listener_fcntls : silk_listener_fcntls - 4;
  if (position == 1 && command != F_GETFL) silk_listener_configuration_ok = 0;
  if (position == 2 && (command != F_SETFL || (argument & O_NONBLOCK) == 0))
    silk_listener_configuration_ok = 0;
  if (position == 3 && command != F_GETFD) silk_listener_configuration_ok = 0;
  if (position == 4 && (command != F_SETFD || (argument & FD_CLOEXEC) == 0))
    silk_listener_configuration_ok = 0;
  if (fd == 40 && position == 4) silk_listener_setup_order = 2;
  if (silk_listener_mode == 202 && fd == 41 && position == 1) { errno = EIO; return -1; }
  return 0;
}

int bind(int fd, const struct sockaddr *address, socklen_t length) {
  if (!silk_listener_darwin_scripted()) {
    static int (*real_bind)(int, const struct sockaddr *, socklen_t) = NULL;
    if (real_bind == NULL) real_bind = dlsym(RTLD_NEXT, "bind");
    return real_bind(fd, address, length);
  }
  silk_listener_binds += 1;
  int expected_order = silk_listener_mode == 203 ? 3 : 2;
  if (silk_listener_setup_order != expected_order) silk_listener_configuration_ok = 0;
  silk_listener_setup_order = expected_order + 1;
  if (silk_listener_mode == 203) {
    const struct sockaddr_in6 *value = (const struct sockaddr_in6 *)address;
    if (fd != 40 || address == NULL || length != sizeof(*value)
        || value->sin6_family != AF_INET6 || value->sin6_len != sizeof(*value))
      silk_listener_configuration_ok = 0;
  } else if (fd != 40 || address == NULL || length != sizeof(struct sockaddr_in)
      || address->sa_family != AF_INET || address->sa_len != sizeof(struct sockaddr_in)) {
    silk_listener_configuration_ok = 0;
  }
  return 0;
}

int listen(int fd, int backlog) {
  if (!silk_listener_darwin_scripted()) {
    static int (*real_listen)(int, int) = NULL;
    if (real_listen == NULL) real_listen = dlsym(RTLD_NEXT, "listen");
    return real_listen(fd, backlog);
  }
  silk_listener_listens += 1;
  int expected_order = silk_listener_mode == 203 ? 4 : 3;
  if (silk_listener_setup_order != expected_order) silk_listener_configuration_ok = 0;
  silk_listener_setup_order = expected_order + 1;
  if (fd != 40 || backlog != 128) silk_listener_configuration_ok = 0;
  return 0;
}

static void silk_listener_darwin_fill_v4(
  struct sockaddr *address,
  socklen_t *length,
  uint16_t port,
  unsigned char last,
  unsigned char declared_length
) {
  struct sockaddr_in *value = (struct sockaddr_in *)address;
  memset(value, 0, sizeof(*value));
  value->sin_len = declared_length;
  value->sin_family = AF_INET;
  value->sin_port = htons(port);
  value->sin_addr.s_addr = htonl(0xc0000200u + last);
  *length = (socklen_t)sizeof(*value);
}

static void silk_listener_darwin_fill_v6(
  struct sockaddr *address,
  socklen_t *length,
  uint16_t port
) {
  struct sockaddr_in6 *value = (struct sockaddr_in6 *)address;
  memset(value, 0, sizeof(*value));
  value->sin6_len = sizeof(*value);
  value->sin6_family = AF_INET6;
  value->sin6_port = htons(port);
  value->sin6_addr = in6addr_loopback;
  *length = (socklen_t)sizeof(*value);
}

int getsockname(int fd, struct sockaddr *address, socklen_t *length) {
  if (!silk_listener_darwin_scripted()) {
    static int (*real_getsockname)(int, struct sockaddr *, socklen_t *) = NULL;
    if (real_getsockname == NULL) real_getsockname = dlsym(RTLD_NEXT, "getsockname");
    return real_getsockname(fd, address, length);
  }
  silk_listener_getsocknames += 1;
  int expected_order = silk_listener_mode == 203 ? 5 : 4;
  if (silk_listener_setup_order != expected_order) silk_listener_configuration_ok = 0;
  silk_listener_setup_order = expected_order + 1;
  if (fd != 40 || address == NULL || length == NULL || *length != 128)
    silk_listener_configuration_ok = 0;
  if (silk_listener_mode == 203) silk_listener_darwin_fill_v6(address, length, 43211);
  else silk_listener_darwin_fill_v4(address, length, 43210, 1, 16);
  return 0;
}

int accept(int fd, struct sockaddr *address, socklen_t *length) {
  if (!silk_listener_darwin_scripted()) {
    static int (*real_accept)(int, struct sockaddr *, socklen_t *) = NULL;
    if (real_accept == NULL) real_accept = dlsym(RTLD_NEXT, "accept");
    return silk_listener_http_admitted(fd, real_accept(fd, address, length));
  }
  silk_listener_accepts += 1;
  int expected_order = silk_listener_mode == 203 ? 6 : 5;
  if (silk_listener_setup_order != expected_order) silk_listener_configuration_ok = 0;
  if (fd != 40 || address == NULL || length == NULL || *length != 128)
    silk_listener_configuration_ok = 0;
  unsigned char declared_length = silk_listener_mode == 201 ? 15 : 16;
  silk_listener_darwin_fill_v4(address, length, 1234, 9, declared_length);
  return 41;
}

int setsockopt(int fd, int level, int option, const void *value, socklen_t length) {
  if (!silk_listener_darwin_scripted()) {
    static int (*real_setsockopt)(int, int, int, const void *, socklen_t) = NULL;
    if (real_setsockopt == NULL) real_setsockopt = dlsym(RTLD_NEXT, "setsockopt");
    return real_setsockopt(fd, level, option, value, length);
  }
  silk_listener_setsockopts += 1;
  if (silk_listener_mode == 203 && fd == 40) {
    if (silk_listener_setup_order != 2 || level != IPPROTO_IPV6 || option != IPV6_V6ONLY
        || value == NULL || length != sizeof(int) || *(const int *)value != 1)
      silk_listener_configuration_ok = 0;
    silk_listener_setup_order = 3;
    return 0;
  }
  if (fd != 41 || level != SOL_SOCKET || value == NULL
      || (option != SO_LINGER && option != SO_NOSIGPIPE)
      || (option == SO_LINGER && length != sizeof(struct linger))
      || (option == SO_NOSIGPIPE && length != sizeof(int)))
    silk_listener_configuration_ok = 0;
  return 0;
}

int silk_listener_close_nocancel(int fd) __asm("_close$NOCANCEL");
int silk_listener_close_nocancel(int fd) {
  if (!silk_listener_darwin_scripted()) {
    static int (*real_close)(int) = NULL;
    if (real_close == NULL) real_close = dlsym(RTLD_NEXT, "close");
    silk_listener_http_closed(fd);
    return real_close(fd);
  }
  silk_listener_closes += 1;
  if (fd == 40) silk_listener_closed_listener += 1;
  if (fd == 41) silk_listener_closed_accepted += 1;
  return 0;
}
#endif

static silk_socket silk_listener_client = -1;

static int silk_listener_http_connect_failed(int result) {
  if (silk_listener_client >= 0) (void)close(silk_listener_client);
  silk_listener_client = -1;
  silk_listener_http_active = 0;
#if defined(_WIN32)
  WSACleanup();
#endif
  return result;
}

int silk_listener_connect_http(int port) {
#if defined(_WIN32)
  uint64_t data[51] = {0};
  if (WSAStartup(0x202, data) != 0) return 1;
#endif
  static const char request[] = "GET /native-admission HTTP/1.1\r\nHost: localhost\r\n\r\n";
  struct sockaddr_in address;
  memset(&address, 0, sizeof(address));
  address.sin_family = AF_INET;
  address.sin_port = htons((uint16_t)port);
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  silk_listener_http_active = 1;
  silk_listener_http_accepted = -1;
  silk_listener_http_listener = -1;
  silk_listener_http_accepts = 0;
  silk_listener_http_accepted_closes = 0;
  silk_listener_http_listener_closes = 0;
  silk_listener_client = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (silk_listener_client < 0) return silk_listener_http_connect_failed(1);
#if defined(_WIN32)
  uint32_t deadline = 5000;
#else
  struct timeval deadline = {.tv_sec = 5, .tv_usec = 0};
#endif
  if (setsockopt(silk_listener_client, SOL_SOCKET, SO_RCVTIMEO, &deadline, sizeof(deadline)) != 0
      || setsockopt(silk_listener_client, SOL_SOCKET, SO_SNDTIMEO, &deadline, sizeof(deadline)) != 0
      || connect(silk_listener_client, (const struct sockaddr *)&address, sizeof(address)) != 0)
    return silk_listener_http_connect_failed(2);
  size_t sent = 0;
  while (sent < sizeof(request) - 1) {
    ssize_t count = write(silk_listener_client, request + sent, sizeof(request) - 1 - sent);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return silk_listener_http_connect_failed(3);
    sent += (size_t)count;
  }
  if (shutdown(silk_listener_client, SHUT_WR) != 0) return silk_listener_http_connect_failed(4);
  return 42;
}

int silk_listener_finish_http(void) {
  static const char expected[] = "HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n";
  unsigned char response[sizeof(expected)];
  size_t used = 0;
  int ended = 0;
  while (used < sizeof(response)) {
    ssize_t count = read(silk_listener_client, response + used, sizeof(response) - used);
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) {
      if (errno == ECONNRESET) ended = 1; /* Accepted-owner release is abortive. */
      break;
    }
    if (count == 0) { ended = 1; break; }
    used += (size_t)count;
  }
  int result = ended && used == sizeof(expected) - 1
    && memcmp(response, expected, used) == 0
    && silk_listener_http_accepts == 1
    && silk_listener_http_accepted_closes == 1
    && silk_listener_http_listener_closes == 0 ? 42 : 5;
  if (silk_listener_client >= 0) (void)close(silk_listener_client);
  silk_listener_client = -1;
#if defined(_WIN32)
  if (WSACleanup() != 0) return 7;
#endif
  return result;
}

int silk_listener_http_ownership(void) {
  int result = silk_listener_http_accepts == 1 && silk_listener_http_accepted_closes == 1
    && silk_listener_http_listener_closes == 1 ? 42 : 6;
  silk_listener_http_active = 0;
  return result;
}


#if !defined(_WIN32)
static int silk_listener_copy_path(char *output, size_t capacity, const unsigned char *path, size_t length) {
  if (path == NULL || length == 0 || length >= capacity) return 0;
  memcpy(output, path, length);
  output[length] = 0;
  return 1;
}
#endif

int silk_listener_connect_tcp(int port) {
#if defined(_WIN32)
  uint64_t data[51] = {0};
  if (WSAStartup(0x202, data) != 0) return 1;
#endif
  struct sockaddr_in address;
  memset(&address, 0, sizeof(address));
  address.sin_family = AF_INET;
  address.sin_port = htons((uint16_t)port);
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  silk_listener_client = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (silk_listener_client < 0) return silk_listener_http_connect_failed(1);
  if (connect(silk_listener_client, (const struct sockaddr *)&address, sizeof(address)) != 0) return silk_listener_http_connect_failed(2);
  if (write(silk_listener_client, "x", 1) != 1) return silk_listener_http_connect_failed(3);
  return 42;
}

#if !defined(_WIN32)
int silk_listener_connect_unix(const unsigned char *path, size_t length) {
  struct sockaddr_un address;
  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  if (!silk_listener_copy_path(address.sun_path, sizeof(address.sun_path), path, length)) return 4;
  silk_listener_client = socket(AF_UNIX, SOCK_STREAM, 0);
  if (silk_listener_client < 0) return 5;
  if (connect(silk_listener_client, (const struct sockaddr *)&address,
      (socklen_t)(offsetof(struct sockaddr_un, sun_path) + length + 1)) != 0) return 6;
  if (write(silk_listener_client, "x", 1) != 1) return 7;
  return 42;
}
#endif

int silk_listener_finish_client(int expected) {
  unsigned char byte = 0;
  if (silk_listener_client < 0) return 8;
  if (read(silk_listener_client, &byte, 1) != 1 || byte != (unsigned char)expected) return 9;
  if (close(silk_listener_client) != 0) return 10;
  silk_listener_client = -1;
#if defined(_WIN32)
  if (WSACleanup() != 0) return 11;
#endif
  return 42;
}

#if !defined(_WIN32)
int silk_listener_path_exists(const unsigned char *path, size_t length) {
  char local[sizeof(((struct sockaddr_un *)0)->sun_path)];
  struct stat status;
  if (!silk_listener_copy_path(local, sizeof(local), path, length)) return 0;
  return lstat(local, &status) == 0 && S_ISSOCK(status.st_mode);
}

int silk_listener_unlink(const unsigned char *path, size_t length) {
  char local[sizeof(((struct sockaddr_un *)0)->sun_path)];
  if (!silk_listener_copy_path(local, sizeof(local), path, length)) return 1;
  if (unlink(local) == 0 || errno == ENOENT) return 42;
  return 2;
}
#endif
