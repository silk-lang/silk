#if defined(_WIN32)
#include <stddef.h>
#include <stdint.h>
// Independent Winsock contracts. Use handles above UINT32_MAX so truncation fails
// the same lifecycle witness rather than silently passing with small fake descriptors.
typedef uintptr_t silk_socket;
typedef int silk_transfer;
typedef int silk_count;
typedef int socklen_t;
typedef unsigned nfds_t;
struct sockaddr { uint16_t sa_family; char data[14]; };
struct in_addr { uint32_t s_addr; };
struct sockaddr_in { uint16_t sin_family, sin_port; struct in_addr sin_addr; char zero[8]; };
struct sockaddr_un { uint16_t sun_family; char sun_path[108]; };
struct linger { uint16_t l_onoff, l_linger; };
struct pollfd { silk_socket fd; short events, revents; };
#define AF_INET 2
#define AF_INET6 23
#define AF_UNIX 1
#define SOCK_STREAM 1
#define IPPROTO_TCP 6
#define SOL_SOCKET 65535
#define SO_LINGER 128
#define SO_ERROR 4103
#define TCP_NODELAY 1
#define SHUT_WR 1
#define POLLIN 768
#define POLLOUT 16
#define POLLERR 1
#define POLLHUP 2
#define POLLNVAL 4
#define EIO 10014
#define EINVAL 10022
#define ECONNREFUSED 10061
#define EINPROGRESS 10035
#define EAGAIN 10035
#define EINTR 10004
#define EACCES 10013
#define ECONNRESET 10054
#define EPIPE 10058
#define ENOTCONN 10057
#define SOCKET_BASE ((silk_socket)0x100000000ULL)
static int silk_wsa_error;
#define errno silk_wsa_error
#define poll WSAPoll
#define close closesocket
int memcmp(const void *, const void *, size_t);
__declspec(dllimport) void SetLastError(unsigned long);
static uint16_t ntohs(uint16_t value) { return __builtin_bswap16(value); }
int WSAGetLastError(void) { return silk_wsa_error; }
_Static_assert(sizeof(silk_socket) == 8 && sizeof(struct pollfd) == 16, "Win64 SOCKET and poll layout");
_Static_assert(offsetof(struct pollfd, events) == 8 && offsetof(struct pollfd, revents) == 10, "Winsock poll offsets");
_Static_assert(sizeof(struct linger) == 4 && sizeof(struct sockaddr_in) == 16, "Winsock option and address layout");
#else
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>
typedef int silk_socket;
typedef ssize_t silk_transfer;
typedef size_t silk_count;
#define SOCKET_BASE 0
#endif
#if defined(__linux__)
#include <sys/syscall.h>
#endif

static int silk_mode;
static int silk_sockets;
static int silk_connects;
static int silk_closes;
static int silk_shutdowns;
static int silk_polls;
static int silk_recv_calls;
static int silk_send_calls;
static int silk_fcntl_calls;
static int silk_setsockopt_calls;
static int silk_getsockopt_calls;
static int silk_close_attempts;
static int silk_callbacks;
static int silk_event;
static int silk_callback_event;
static int silk_close_event;
static int silk_first_close_event;
static int silk_second_socket_event;
static int silk_guard_drops;
static int silk_guard_drop_event;
static int silk_wait_registrations;
static int silk_wait_registration_event;
static int silk_completions;
static int silk_nodelay;
static int silk_configuration_ok;
static int silk_transfer_ok;
static int silk_configuration_mask;

void silk_socket_stub_reset(int mode) {
  silk_mode = mode;
  silk_sockets = 0;
  silk_connects = 0;
  silk_closes = 0;
  silk_shutdowns = 0;
  silk_polls = 0;
  silk_recv_calls = 0;
  silk_send_calls = 0;
  silk_fcntl_calls = 0;
  silk_setsockopt_calls = 0;
  silk_getsockopt_calls = 0;
  silk_close_attempts = 0;
  silk_callbacks = 0;
  silk_event = 0;
  silk_callback_event = 0;
  silk_close_event = 0;
  silk_first_close_event = 0;
  silk_second_socket_event = 0;
  silk_guard_drops = 0;
  silk_guard_drop_event = 0;
  silk_wait_registrations = 0;
  silk_wait_registration_event = 0;
  silk_completions = 0;
  silk_nodelay = 0;
  silk_configuration_ok = 1;
  silk_transfer_ok = 1;
  silk_configuration_mask = 0;
}
int silk_socket_stub_sockets(void) { return silk_sockets; }
int silk_socket_stub_connects(void) { return silk_connects; }
int silk_socket_stub_closes(void) {
#if defined(__APPLE__)
  int closed = 0;
  for (int index = 1; index <= silk_sockets; index += 1) {
    errno = 0;
    if (write(100 + index, "", 0) < 0 && errno == EBADF) closed += 1;
  }
  return closed;
#else
  return silk_closes;
#endif
}
int silk_socket_stub_polls(void) { return silk_polls; }
int silk_socket_stub_recvs(void) { return silk_recv_calls; }
int silk_socket_stub_sends(void) { return silk_send_calls; }
int silk_socket_stub_fcntls(void) { return silk_fcntl_calls; }
int silk_socket_stub_setsockopts(void) { return silk_setsockopt_calls; }
int silk_socket_stub_getsockopts(void) { return silk_getsockopt_calls; }
int silk_socket_stub_close_attempts(void) { return silk_close_attempts; }
int silk_socket_stub_shutdowns(void) { return silk_shutdowns; }
int silk_socket_stub_callbacks(void) { return silk_callbacks; }
int silk_socket_stub_callback_event(void) { return silk_callback_event; }
int silk_socket_stub_close_event(void) { return silk_close_event; }
int silk_socket_stub_first_close_event(void) { return silk_first_close_event; }
int silk_socket_stub_second_socket_event(void) { return silk_second_socket_event; }
int silk_socket_stub_guard_drops(void) { return silk_guard_drops; }
int silk_socket_stub_guard_drop_event(void) { return silk_guard_drop_event; }
int silk_socket_stub_wait_registrations(void) { return silk_wait_registrations; }
int silk_socket_stub_wait_registration_event(void) { return silk_wait_registration_event; }
int silk_socket_stub_completions(void) { return silk_completions; }
void silk_socket_stub_mark_guard_drop(void) {
  silk_guard_drops += 1;
  silk_guard_drop_event = ++silk_event;
}
void silk_socket_stub_mark_wait_registration(void) {
  silk_wait_registrations += 1;
  silk_wait_registration_event = ++silk_event;
}
void silk_socket_stub_mark_callback(void) {
  silk_callbacks += 1;
  silk_callback_event = ++silk_event;
}
void silk_socket_stub_mark_completion(void) { silk_completions += 1; }
int silk_socket_stub_nodelay(void) { return silk_nodelay; }
int silk_socket_stub_configuration_ok(void) {
#if defined(_WIN32)
  return silk_configuration_ok && (silk_configuration_mask & 7) == 7;
#elif defined(__APPLE__)
  return silk_configuration_ok && (silk_configuration_mask & 15) == 15;
#else
  return silk_configuration_ok && (silk_configuration_mask & 5) == 5;
#endif
}
int silk_socket_stub_transfer_ok(void) { return silk_transfer_ok; }

#if defined(_WIN32)
silk_socket WSASocketW(int domain, int type, int protocol, void *information, unsigned group, unsigned flags) {
  if (information != NULL || group != 0 || flags != 128) silk_configuration_ok = 0;
#else
int socket(int domain, int type, int protocol) {
#endif
  silk_sockets += 1;
  int socket_event = ++silk_event;
  if (silk_sockets == 2) silk_second_socket_event = socket_event;
#if defined(__linux__)
  if ((type & SOCK_NONBLOCK) == 0 || (type & SOCK_CLOEXEC) == 0) silk_configuration_ok = 0;
  silk_configuration_mask |= 1;
#else
  if (type != SOCK_STREAM) silk_configuration_ok = 0;
#endif
  if (domain != AF_INET && domain != AF_INET6 && domain != AF_UNIX) silk_configuration_ok = 0;
  if (domain == AF_UNIX && protocol != 0) silk_configuration_ok = 0;
  if (domain != AF_UNIX && protocol != IPPROTO_TCP) silk_configuration_ok = 0;
  if (silk_mode == 54) { errno = EIO; return -1; }
#if defined(__APPLE__)
  int seed = open("/dev/null", O_RDWR);
  int descriptor = 100 + silk_sockets;
  if (seed < 0 || dup2(seed, descriptor) < 0) return -1;
  close(seed);
  return descriptor;
#else
  return SOCKET_BASE + 100 + silk_sockets;
#endif
}

#if defined(_WIN32)
int ioctlsocket(silk_socket fd, int command, unsigned *value) {
  silk_fcntl_calls += 1;
  if (fd != SOCKET_BASE + 100 + silk_sockets || command != (int)0x8004667eU || value == NULL || *value != 1)
    silk_configuration_ok = 0;
  if (silk_mode == 55) { errno = EIO; return -1; }
  silk_configuration_mask |= 1;
  return 0;
}
int SetHandleInformation(silk_socket fd, unsigned mask, unsigned flags) {
  silk_fcntl_calls += 1;
  if (fd != SOCKET_BASE + 100 + silk_sockets || mask != 1 || flags != 0 || !(silk_configuration_mask & 1))
    silk_configuration_ok = 0;
  if (silk_mode == 56) { SetLastError(5); return 0; }
  silk_configuration_mask |= 2;
  return 1;
}
#endif

#if defined(__APPLE__)
int fcntl(int fd, int command, ...) {
  silk_fcntl_calls += 1;
  if (silk_mode >= 55 && silk_mode <= 58 && silk_fcntl_calls == silk_mode - 54) {
    errno = EIO;
    return -1;
  }
  if (fd < SOCKET_BASE + 100) return -1;
  if (command == F_GETFL) return 0;
  if (command == F_GETFD) return 0;
  va_list arguments;
  va_start(arguments, command);
  int value = va_arg(arguments, int);
  va_end(arguments);
  if (command == F_SETFL) {
    if ((value & O_NONBLOCK) == 0) silk_configuration_ok = 0;
    silk_configuration_mask |= 1;
    return 0;
  }
  if (command == F_SETFD) {
    if ((value & FD_CLOEXEC) == 0) silk_configuration_ok = 0;
    silk_configuration_mask |= 2;
    return 0;
  }
  silk_configuration_ok = 0;
  errno = EINVAL;
  return -1;
}
#endif

int setsockopt(silk_socket fd, int level, int option, const void *value, socklen_t length) {
  silk_setsockopt_calls += 1;
  if (fd < SOCKET_BASE + 100 || value == NULL || length == 0) silk_configuration_ok = 0;
  if (level == SOL_SOCKET && option == SO_LINGER) {
    const struct linger *linger = (const struct linger *)value;
    if (length != sizeof(*linger) || linger->l_onoff != 0 || linger->l_linger != 0) silk_configuration_ok = 0;
    silk_configuration_mask |= 4;
    if (silk_mode == 43) { errno = EIO; return -1; }
  }
#if defined(__APPLE__)
  if (level == SOL_SOCKET && option == SO_NOSIGPIPE) {
    if (length != sizeof(int) || *(const int *)value != 1) silk_configuration_ok = 0;
    silk_configuration_mask |= 8;
    if (silk_mode == 60) { errno = EIO; return -1; }
  }
#endif
  if (level == IPPROTO_TCP && option == TCP_NODELAY) {
    if (length != sizeof(int) || *(const int *)value != 1) silk_configuration_ok = 0;
    silk_nodelay += 1;
    if (silk_mode == 61) { errno = EIO; return -1; }
  }
  return 0;
}

int connect(silk_socket fd, const struct sockaddr *address, socklen_t length) {
  silk_connects += 1;
  if (fd < SOCKET_BASE + 100 || address == NULL || length < 2) silk_configuration_ok = 0;
  if (address != NULL && address->sa_family == AF_INET) {
    const struct sockaddr_in *ipv4 = (const struct sockaddr_in *)address;
    unsigned char expected = silk_mode == 1 ? (unsigned char)silk_connects : 1;
    const unsigned char *bytes = (const unsigned char *)&ipv4->sin_addr;
    if (length != sizeof(*ipv4) || ntohs(ipv4->sin_port) != 443 || bytes[3] != expected) {
      silk_configuration_ok = 0;
    }
  }
  if (address != NULL && address->sa_family == AF_UNIX) {
    const struct sockaddr_un *local = (const struct sockaddr_un *)address;
    static const char expected[] = "/tmp/silk-jul-146.sock";
    if (length != offsetof(struct sockaddr_un, sun_path) + sizeof(expected)
      || memcmp(local->sun_path, expected, sizeof(expected)) != 0) {
      silk_configuration_ok = 0;
    }
  }
  if (silk_mode == 1 && silk_connects == 1) { errno = ECONNREFUSED; return -1; }
  if (silk_mode == 2 || silk_mode == 4 || silk_mode == 6) { errno = EINPROGRESS; return -1; }
  if (silk_mode == 5 && silk_connects == 1) { errno = EINTR; return -1; }
  if (silk_mode == 7) { errno = EACCES; return -1; }
#if defined(__linux__)
  if (silk_mode == 3 && silk_connects == 1) { errno = EAGAIN; return -1; }
#endif
  return 0;
}

int poll(struct pollfd *fds, nfds_t count, int timeout) {
  silk_polls += 1;
  if (count != 1 || timeout != 0 || fds == NULL) silk_configuration_ok = 0;
  if (silk_mode == 46 && silk_polls == 1) { errno = EINTR; return -1; }
  if (silk_mode == 47) { errno = EIO; return -1; }
  if (fds != NULL) {
    if (fds[0].fd < SOCKET_BASE + 100) silk_configuration_ok = 0;
    if (silk_mode == 4 || silk_mode == 6 || silk_mode == 62) fds[0].revents = 0;
    else if (silk_mode == 31 || silk_mode == 32) fds[0].revents = POLLIN;
    else if (silk_mode == 34 || silk_mode == 35) fds[0].revents = POLLOUT;
    else if (silk_mode == 36 || silk_mode == 50) fds[0].revents = POLLHUP;
    else if (silk_mode == 37 || silk_mode == 48) fds[0].revents = POLLERR;
    else if (silk_mode == 38) fds[0].revents = POLLNVAL;
    else fds[0].revents = POLLOUT;
  }
  if (silk_mode == 4 || silk_mode == 6 || silk_mode == 62) return 0;
  return 1;
}

int getsockopt(silk_socket fd, int level, int option, void *value, socklen_t *length) {
  silk_getsockopt_calls += 1;
  if (fd < SOCKET_BASE + 100 || level != SOL_SOCKET || option != SO_ERROR || value == NULL || length == NULL) {
    errno = EINVAL;
    return -1;
  }
  if (*length < (socklen_t)sizeof(int)) { errno = EINVAL; return -1; }
  if (silk_mode == 48) { errno = EIO; return -1; }
  *(int *)value = 0;
  if (silk_mode == 37) *(int *)value = ECONNRESET;
  *length = sizeof(int);
  return 0;
}

silk_transfer recv(silk_socket fd, void *buffer, silk_count length, int flags) {
  if (fd < SOCKET_BASE + 100 || buffer == NULL || length == 0 || flags != 0) silk_transfer_ok = 0;
  silk_recv_calls += 1;
  if (silk_mode == 62 && silk_recv_calls == 1) { errno = EAGAIN; return -1; }
  if (silk_mode == 6) { errno = EAGAIN; return -1; }
  if (silk_mode == 30 && silk_recv_calls == 1) { errno = EINTR; return -1; }
  if ((silk_mode == 31 || silk_mode == 36 || silk_mode == 37 || silk_mode == 38
      || silk_mode == 46 || silk_mode == 47 || silk_mode == 48)
    && silk_recv_calls == 1) { errno = EAGAIN; return -1; }
  if (silk_mode == 32 && silk_recv_calls <= 2) { errno = EAGAIN; return -1; }
  if (silk_mode == 39) return (silk_transfer)length + 1;
  int data_call = silk_recv_calls == 1;
  if (silk_mode == 30 || silk_mode == 31 || silk_mode == 36 || silk_mode == 46) {
    data_call = silk_recv_calls == 2;
  }
  if (silk_mode == 32) data_call = silk_recv_calls == 3;
  if (silk_mode == 62) data_call = silk_recv_calls == 2;
  if (data_call) {
    if (length < 2) { errno = EINVAL; return -1; }
    ((unsigned char *)buffer)[0] = 'h';
    ((unsigned char *)buffer)[1] = 'i';
    return 2;
  }
  return 0;
}

silk_transfer send(silk_socket fd, const void *buffer, silk_count length, int flags) {
  silk_send_calls += 1;
  if (fd < SOCKET_BASE + 100 || buffer == NULL || length != 5) silk_transfer_ok = 0;
#if defined(__linux__)
  if ((flags & MSG_NOSIGNAL) == 0) silk_transfer_ok = 0;
#else
  if (flags != 0) silk_transfer_ok = 0;
#endif
  if (silk_mode == 33 && silk_send_calls == 1) { errno = EINTR; return -1; }
  if (silk_mode == 34 && silk_send_calls == 1) { errno = EAGAIN; return -1; }
  if (silk_mode == 35 && silk_send_calls <= 2) { errno = EAGAIN; return -1; }
  if (silk_mode == 40) return 0;
  if (silk_mode == 41) return (silk_transfer)length + 1;
  if (silk_mode == 45) { errno = EPIPE; return -1; }
  if (silk_mode == 50 && silk_send_calls == 1) { errno = EAGAIN; return -1; }
  return 2;
}

int shutdown(silk_socket fd, int how) {
  if (fd < SOCKET_BASE + 100 || how != SHUT_WR) silk_transfer_ok = 0;
  silk_shutdowns += 1;
  if (silk_mode == 51 && silk_shutdowns == 1) { errno = EINTR; return -1; }
  if (silk_mode == 52) { errno = ENOTCONN; return -1; }
  if (silk_mode == 53) { errno = EIO; return -1; }
  return 0;
}

#if defined(__APPLE__)
int silk_socket_close_nocancel(int fd) __asm("_close$NOCANCEL");
int silk_socket_close_nocancel(int fd) {
  if (fd >= SOCKET_BASE + 100) {
    silk_close_attempts += 1;
    silk_closes += 1;
    silk_close_event = ++silk_event;
    if (silk_first_close_event == 0) silk_first_close_event = silk_close_event;
    if (silk_mode == 42) { errno = EIO; return -1; }
  }
  return close(fd);
}
#else
int close(silk_socket fd) {
  if (fd >= SOCKET_BASE + 100) {
    silk_close_attempts += 1;
    silk_closes += 1;
    silk_close_event = ++silk_event;
    if (silk_first_close_event == 0) silk_first_close_event = silk_close_event;
    if (silk_mode == 42) { errno = EIO; return -1; }
    return 0;
  }
#if defined(_WIN32)
  errno = EINVAL;
  return -1;
#else
  return (int)syscall(SYS_close, fd);
#endif
}
#endif
