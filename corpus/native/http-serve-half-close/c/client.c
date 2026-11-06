// A client thread for the corpus case: each connection sends a whole request and its FIN in one
// go, then waits for the server to close. The process exits with 42 when every connection was
// answered and closed, and with 1 when one stayed open. The engine is Linux-only, so other hosts
// build an empty stub.
#if defined(__linux__)
#include <arpa/inet.h>
#include <netinet/in.h>
#include <poll.h>
#include <pthread.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static int port;

static int connect_once(void) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  struct sockaddr_in address;
  memset(&address, 0, sizeof address);
  address.sin_family = AF_INET;
  address.sin_port = htons((uint16_t)port);
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (connect(fd, (struct sockaddr *)&address, sizeof address) != 0) { close(fd); return -1; }
  return fd;
}

static void *run(void *unused) {
  (void)unused;
  int fd = -1;
  for (int attempt = 0; attempt < 500 && fd < 0; attempt++) {
    fd = connect_once();
    if (fd < 0) usleep(10000);
  }
  if (fd < 0) exit(2);
  close(fd);
  static const char request[] = "GET / HTTP/1.1\r\nHost: x\r\n\r\n";
  for (int round = 0; round < 64; round++) {
    fd = connect_once();
    if (fd < 0) exit(3);
    // The request and the end of the stream reach the server together.
    if (write(fd, request, sizeof request - 1) != (ssize_t)(sizeof request - 1)) exit(4);
    shutdown(fd, SHUT_WR);
    char buffer[512];
    size_t total = 0;
    while (1) {
      struct pollfd ready = {fd, POLLIN, 0};
      if (poll(&ready, 1, 3000) != 1) exit(1);
      ssize_t got = read(fd, buffer, sizeof buffer);
      if (got < 0) exit(5);
      if (got == 0) break;
      total += (size_t)got;
    }
    if (total == 0) exit(6);
    close(fd);
  }
  exit(42);
  return 0;
}

void silk_start_half_close_client(int32_t value) {
  port = value;
  pthread_t thread;
  if (pthread_create(&thread, 0, run, 0) != 0) exit(7);
}
#else
#include <stdint.h>
void silk_start_half_close_client(int32_t value) { (void)value; }
#endif
