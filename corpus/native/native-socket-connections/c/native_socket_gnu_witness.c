#if defined(__linux__)

#define _GNU_SOURCE
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
#if defined(__linux__) && defined(__GLIBC__)
_Static_assert(sizeof(struct sockaddr_in) == 16, "GNU sockaddr_in size");
_Static_assert(sizeof(struct sockaddr_in6) == 28, "GNU sockaddr_in6 size");
_Static_assert(_Alignof(struct sockaddr_in) == 4, "GNU sockaddr_in alignment");
_Static_assert(_Alignof(struct sockaddr_in6) == 4, "GNU sockaddr_in6 alignment");
_Static_assert(sizeof(struct sockaddr_un) == 110 && _Alignof(struct sockaddr_un) == 2, "GNU sockaddr_un layout");
_Static_assert(sizeof(struct pollfd) == 8 && _Alignof(struct pollfd) == 4, "GNU pollfd layout");
_Static_assert(offsetof(struct pollfd, events) == 4 && offsetof(struct pollfd, revents) == 6, "GNU pollfd offsets");
_Static_assert(sizeof(struct linger) == 8 && _Alignof(struct linger) == 4, "GNU linger layout");
_Static_assert(offsetof(struct sockaddr_in, sin_port) == 2 && offsetof(struct sockaddr_in, sin_addr) == 4, "GNU IPv4 offsets");
_Static_assert(offsetof(struct sockaddr_in6, sin6_port) == 2 && offsetof(struct sockaddr_in6, sin6_addr) == 8, "GNU IPv6 offsets");
_Static_assert(offsetof(struct sockaddr_un, sun_path) == 2, "GNU sockaddr_un header");
_Static_assert(sizeof(((struct sockaddr_un *)0)->sun_path) == 108, "GNU sun_path capacity");
_Static_assert(AF_INET == 2 && AF_INET6 == 10 && AF_UNIX == 1, "GNU families");
_Static_assert(SO_ERROR == 4 && SO_LINGER == 13, "GNU socket options");
_Static_assert(IPPROTO_TCP == 6 && TCP_NODELAY == 1 && SHUT_WR == 1, "GNU TCP and shutdown constants");
_Static_assert(SOCK_NONBLOCK == 2048 && SOCK_CLOEXEC == 524288 && MSG_NOSIGNAL == 16384, "GNU setup and send flags");
_Static_assert(EINTR == 4 && EINPROGRESS == 115 && EAGAIN == 11 && EWOULDBLOCK == EAGAIN, "GNU retry errno");
_Static_assert(EPERM == 1 && EIO == 5 && EBADF == 9 && ENOMEM == 12 && EACCES == 13, "GNU core errno");
_Static_assert(ENFILE == 23 && EMFILE == 24, "GNU resource errno");
_Static_assert(ECONNREFUSED == 111 && ENETUNREACH == 101 && EADDRNOTAVAIL == 99 && ENOBUFS == 105, "GNU mapped errno");
_Static_assert(EAFNOSUPPORT == 97 && ENOTCONN == 107 && ECONNRESET == 104 && EPIPE == 32, "GNU socket errno");
_Static_assert(POLLIN == 1 && POLLOUT == 4 && POLLERR == 8 && POLLHUP == 16 && POLLNVAL == 32, "GNU poll bits");
_Static_assert(SOCK_STREAM == 1, "GNU stream socket type");
_Static_assert(sizeof(int) == 4 && sizeof(socklen_t) == 4 && sizeof(nfds_t) == 8, "GNU ABI argument widths");
_Static_assert(sizeof(size_t) == sizeof(void *) && sizeof(ssize_t) == sizeof(void *), "GNU transfer widths");
_Static_assert(SSIZE_MAX == INTPTR_MAX, "GNU transfer maximum");
static int (*silk_socket_signature)(int, int, int) = socket;
static int (*silk_connect_signature)(int, const struct sockaddr *, socklen_t) = connect;
static int (*silk_getsockopt_signature)(int, int, int, void *, socklen_t *) = getsockopt;
static int (*silk_setsockopt_signature)(int, int, int, const void *, socklen_t) = setsockopt;
static ssize_t (*silk_recv_signature)(int, void *, size_t, int) = recv;
static ssize_t (*silk_send_signature)(int, const void *, size_t, int) = send;
_Static_assert(sizeof(struct iovec) == 16 && offsetof(struct iovec, iov_len) == 8, "GNU iovec layout");
_Static_assert(sizeof(struct msghdr) == 56 && offsetof(struct msghdr, msg_namelen) == 8, "GNU msghdr size");
_Static_assert(offsetof(struct msghdr, msg_iov) == 16 && offsetof(struct msghdr, msg_iovlen) == 24, "GNU msghdr vectors");
_Static_assert(offsetof(struct msghdr, msg_control) == 32 && offsetof(struct msghdr, msg_controllen) == 40, "GNU msghdr control");
_Static_assert(offsetof(struct msghdr, msg_flags) == 48 && sizeof(((struct msghdr *)0)->msg_iovlen) == 8, "GNU msghdr flags");
static ssize_t (*silk_sendmsg_signature)(int, const struct msghdr *, int) = sendmsg;
static int (*silk_shutdown_signature)(int, int) = shutdown;
static int (*silk_poll_signature)(struct pollfd *, nfds_t, int) = poll;
static int *(*silk_errno_signature)(void) = __errno_location;
static int (*silk_close_signature)(int) = close;
#endif
#endif
int silk_socket_gnu_witness(void) { return 42; }
