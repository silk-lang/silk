#if defined(__APPLE__)

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
#if defined(__APPLE__)
_Static_assert(sizeof(socklen_t) == 4, "Darwin socklen_t width");
_Static_assert(sizeof(struct sockaddr_storage) == 128, "Darwin sockaddr_storage size");
_Static_assert(_Alignof(struct sockaddr_storage) == 8, "Darwin sockaddr_storage alignment");
_Static_assert(sizeof(struct sockaddr_in) == 16 && _Alignof(struct sockaddr_in) == 4, "Darwin IPv4 layout");
_Static_assert(offsetof(struct sockaddr_in, sin_port) == 2 && offsetof(struct sockaddr_in, sin_addr) == 4, "Darwin IPv4 offsets");
_Static_assert(sizeof(struct sockaddr_in6) == 28 && _Alignof(struct sockaddr_in6) == 4, "Darwin IPv6 layout");
_Static_assert(offsetof(struct sockaddr_in6, sin6_port) == 2 && offsetof(struct sockaddr_in6, sin6_addr) == 8, "Darwin IPv6 offsets");
_Static_assert(sizeof(struct sockaddr_un) == 106 && _Alignof(struct sockaddr_un) == 1, "Darwin Unix layout");
_Static_assert(offsetof(struct sockaddr_un, sun_path) == 2, "Darwin Unix header");
_Static_assert(sizeof(((struct sockaddr_un *)0)->sun_path) == 104, "Darwin Unix capacity");
_Static_assert(AF_INET == 2 && AF_INET6 == 30 && AF_UNIX == 1, "Darwin families");
_Static_assert(SOCK_STREAM == 1 && IPPROTO_TCP == 6, "Darwin stream protocol");
_Static_assert(SOL_SOCKET == 0xffff && SO_ERROR == 0x1007 && SO_LINGER == 0x0080, "Darwin socket level/options");
_Static_assert(SO_REUSEADDR == 4 && SO_NOSIGPIPE == 0x1022, "Darwin listener socket options");
_Static_assert(IPPROTO_IPV6 == 41 && IPV6_V6ONLY == 27, "Darwin IPv6-only option");
_Static_assert(IPPROTO_TCP == 6 && TCP_NODELAY == 1, "Darwin TCP option");
_Static_assert(O_NONBLOCK == 4 && FD_CLOEXEC == 1, "Darwin descriptor flags");
_Static_assert(F_GETFD == 1 && F_SETFD == 2 && F_GETFL == 3 && F_SETFL == 4, "Darwin fcntl commands");
_Static_assert(POLLIN == 1 && POLLERR == 8 && POLLHUP == 16 && POLLNVAL == 32, "Darwin poll flags");
_Static_assert(SHUT_WR == 1, "Darwin shutdown write");
_Static_assert(EADDRINUSE == 48 && EAGAIN == 35 && EINTR == 4 && EACCES == 13, "Darwin listener errno values");
_Static_assert(ENOMEM == 12 && EMFILE == 24 && ENFILE == 23 && ENOBUFS == 55, "Darwin resource errno values");
_Static_assert(EAFNOSUPPORT == 47 && EBADF == 9 && EINPROGRESS == 36, "Darwin state errno values");
static int (*silk_socket_signature)(int, int, int) = socket;
static int (*silk_bind_signature)(int, const struct sockaddr *, socklen_t) = bind;
static int (*silk_listen_signature)(int, int) = listen;
static int (*silk_getsockname_signature)(int, struct sockaddr *, socklen_t *) = getsockname;
static int (*silk_accept_signature)(int, struct sockaddr *, socklen_t *) = accept;
static int (*silk_poll_signature)(struct pollfd *, nfds_t, int) = poll;
static int (*silk_setsockopt_signature)(int, int, int, const void *, socklen_t) = setsockopt;
static int (*silk_getsockopt_signature)(int, int, int, void *, socklen_t *) = getsockopt;
static int (*silk_fcntl_signature)(int, int, ...) = fcntl;
static int (*silk_close_signature)(int) = close;
#endif
#endif
int silk_listener_darwin_witness(void) { return 42; }
