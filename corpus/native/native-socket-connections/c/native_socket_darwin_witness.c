#if defined(__APPLE__)

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <stddef.h>
#include <stdint.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/uio.h>
#include <sys/un.h>
#include <unistd.h>
#if defined(__APPLE__)
_Static_assert(sizeof(struct sockaddr_in) == 16, "Darwin sockaddr_in size");
_Static_assert(sizeof(struct sockaddr_in6) == 28, "Darwin sockaddr_in6 size");
_Static_assert(_Alignof(struct sockaddr_in) == 4, "Darwin sockaddr_in alignment");
_Static_assert(_Alignof(struct sockaddr_in6) == 4, "Darwin sockaddr_in6 alignment");
_Static_assert(sizeof(struct sockaddr_un) == 106 && _Alignof(struct sockaddr_un) == 1, "Darwin sockaddr_un layout");
_Static_assert(sizeof(struct pollfd) == 8 && _Alignof(struct pollfd) == 4, "Darwin pollfd layout");
_Static_assert(offsetof(struct pollfd, events) == 4 && offsetof(struct pollfd, revents) == 6, "Darwin pollfd offsets");
_Static_assert(sizeof(struct linger) == 8 && _Alignof(struct linger) == 4, "Darwin linger layout");
_Static_assert(offsetof(struct sockaddr_in, sin_port) == 2 && offsetof(struct sockaddr_in, sin_addr) == 4, "Darwin IPv4 offsets");
_Static_assert(offsetof(struct sockaddr_in6, sin6_port) == 2 && offsetof(struct sockaddr_in6, sin6_addr) == 8, "Darwin IPv6 offsets");
_Static_assert(offsetof(struct sockaddr_un, sun_path) == 2, "Darwin sockaddr_un header");
_Static_assert(sizeof(((struct sockaddr_un *)0)->sun_path) == 104, "Darwin sun_path capacity");
_Static_assert(AF_INET == 2 && AF_INET6 == 30 && AF_UNIX == 1, "Darwin families");
_Static_assert(SO_ERROR == 0x1007 && SO_LINGER == 0x80 && SO_NOSIGPIPE == 0x1022, "Darwin socket options");
_Static_assert(IPPROTO_TCP == 6 && TCP_NODELAY == 1 && SHUT_WR == 1, "Darwin TCP and shutdown constants");
_Static_assert(O_NONBLOCK == 4 && FD_CLOEXEC == 1 && F_GETFL == 3 && F_SETFL == 4 && F_GETFD == 1 && F_SETFD == 2, "Darwin setup flags");
_Static_assert(EINTR == 4 && EINPROGRESS == 36 && EAGAIN == 35 && EWOULDBLOCK == EAGAIN, "Darwin retry errno");
_Static_assert(EPERM == 1 && EIO == 5 && EBADF == 9 && ENOMEM == 12 && EACCES == 13, "Darwin core errno");
_Static_assert(ENFILE == 23 && EMFILE == 24, "Darwin resource errno");
_Static_assert(ECONNREFUSED == 61 && ENETUNREACH == 51 && EADDRNOTAVAIL == 49 && ENOBUFS == 55, "Darwin mapped errno");
_Static_assert(EAFNOSUPPORT == 47 && ENOTCONN == 57 && ECONNRESET == 54 && EPIPE == 32, "Darwin socket errno");
_Static_assert(POLLIN == 1 && POLLOUT == 4 && POLLERR == 8 && POLLHUP == 16 && POLLNVAL == 32, "Darwin poll bits");
_Static_assert(SOCK_STREAM == 1, "Darwin stream socket type");
_Static_assert(sizeof(int) == 4 && sizeof(socklen_t) == 4 && sizeof(nfds_t) == 4, "Darwin ABI argument widths");
_Static_assert(sizeof(size_t) == sizeof(void *) && sizeof(ssize_t) == sizeof(void *), "Darwin transfer widths");
_Static_assert(SSIZE_MAX == INTPTR_MAX, "Darwin transfer maximum");
extern int silk_close_nocancel(int) __asm("_close$NOCANCEL");
static int (*silk_socket_signature)(int, int, int) = socket;
static int (*silk_connect_signature)(int, const struct sockaddr *, socklen_t) = connect;
static int (*silk_getsockopt_signature)(int, int, int, void *, socklen_t *) = getsockopt;
static int (*silk_setsockopt_signature)(int, int, int, const void *, socklen_t) = setsockopt;
static ssize_t (*silk_recv_signature)(int, void *, size_t, int) = recv;
static ssize_t (*silk_send_signature)(int, const void *, size_t, int) = send;
_Static_assert(sizeof(struct iovec) == 16 && offsetof(struct iovec, iov_len) == 8, "Darwin iovec layout");
static ssize_t (*silk_writev_signature)(int, const struct iovec *, int) = writev;
static int (*silk_shutdown_signature)(int, int) = shutdown;
static int (*silk_poll_signature)(struct pollfd *, nfds_t, int) = poll;
static int (*silk_fcntl_signature)(int, int, ...) = fcntl;
static int *(*silk_error_signature)(void) = __error;
static int (*silk_close_signature)(int) = silk_close_nocancel;
#endif
#endif
int silk_socket_darwin_witness(void) { return 42; }
