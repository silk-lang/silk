#if defined(__linux__)

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <stddef.h>
#include <stdint.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#if defined(__linux__) && defined(__GLIBC__)
_Static_assert(sizeof(socklen_t) == 4, "GNU socklen_t width");
_Static_assert(sizeof(struct sockaddr_storage) == 128, "GNU sockaddr_storage size");
_Static_assert(_Alignof(struct sockaddr_storage) == 8, "GNU sockaddr_storage alignment");
_Static_assert(sizeof(struct sockaddr_in) == 16 && _Alignof(struct sockaddr_in) == 4, "GNU IPv4 layout");
_Static_assert(offsetof(struct sockaddr_in, sin_port) == 2 && offsetof(struct sockaddr_in, sin_addr) == 4, "GNU IPv4 offsets");
_Static_assert(sizeof(struct sockaddr_in6) == 28 && _Alignof(struct sockaddr_in6) == 4, "GNU IPv6 layout");
_Static_assert(offsetof(struct sockaddr_in6, sin6_port) == 2 && offsetof(struct sockaddr_in6, sin6_addr) == 8, "GNU IPv6 offsets");
_Static_assert(sizeof(struct sockaddr_un) == 110 && _Alignof(struct sockaddr_un) == 2, "GNU Unix layout");
_Static_assert(offsetof(struct sockaddr_un, sun_path) == 2, "GNU Unix header");
_Static_assert(sizeof(((struct sockaddr_un *)0)->sun_path) == 108, "GNU Unix capacity");
_Static_assert(AF_INET == 2 && AF_INET6 == 10 && AF_UNIX == 1, "GNU families");
_Static_assert(SOCK_STREAM == 1 && IPPROTO_TCP == 6, "GNU stream protocol");
_Static_assert(SOL_SOCKET == 1 && SO_ERROR == 4 && SO_LINGER == 13, "GNU socket level/options");
_Static_assert(SO_REUSEADDR == 2 && IPPROTO_IPV6 == 41 && IPV6_V6ONLY == 26, "GNU listener options");
_Static_assert(IPPROTO_TCP == 6 && TCP_NODELAY == 1, "GNU TCP option");
_Static_assert(SOCK_NONBLOCK == 2048 && SOCK_CLOEXEC == 524288, "GNU atomic flags");
_Static_assert(POLLIN == 1 && POLLERR == 8 && POLLHUP == 16 && POLLNVAL == 32, "GNU poll flags");
_Static_assert(MSG_NOSIGNAL == 16384 && SHUT_WR == 1, "GNU transfer flags");
_Static_assert(EADDRINUSE == 98 && ECONNABORTED == 103 && ENETDOWN == 100, "GNU accept errno values");
_Static_assert(EPROTO == 71 && ENOPROTOOPT == 92 && EHOSTDOWN == 112, "GNU pending errno values");
_Static_assert(ENONET == 64 && EHOSTUNREACH == 113 && EOPNOTSUPP == 95 && ENETUNREACH == 101, "GNU pending network values");
_Static_assert(EAGAIN == 11 && EINTR == 4 && EACCES == 13 && EPERM == 1, "GNU retry/permission errno values");
_Static_assert(ENOMEM == 12 && EMFILE == 24 && ENFILE == 23 && ENOBUFS == 105, "GNU resource errno values");
_Static_assert(EAFNOSUPPORT == 97 && EBADF == 9 && EINPROGRESS == 115, "GNU state errno values");
static int (*silk_socket_signature)(int, int, int) = socket;
static int (*silk_bind_signature)(int, const struct sockaddr *, socklen_t) = bind;
static int (*silk_listen_signature)(int, int) = listen;
static int (*silk_getsockname_signature)(int, struct sockaddr *, socklen_t *) = getsockname;
static int (*silk_accept4_signature)(int, struct sockaddr *, socklen_t *, int) = accept4;
static int (*silk_poll_signature)(struct pollfd *, nfds_t, int) = poll;
static int (*silk_setsockopt_signature)(int, int, int, const void *, socklen_t) = setsockopt;
static int (*silk_getsockopt_signature)(int, int, int, void *, socklen_t *) = getsockopt;
static int (*silk_close_signature)(int) = close;
#endif
#endif
int silk_listener_gnu_witness(void) { return 42; }
