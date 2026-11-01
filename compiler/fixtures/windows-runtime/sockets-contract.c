// A separately compiled Winsock peer. Payloads and the address layout are fixed independently
// from Silk; no Silk socket operation is implemented by this companion.
typedef unsigned long long Socket;
typedef struct { unsigned short family, port; unsigned char address[4], padding[8]; } Address;
_Static_assert(sizeof(Socket) == 8 && sizeof(Address) == 16, "Win64 socket ABI");
__declspec(dllimport) int WSAStartup(unsigned short, void *);
__declspec(dllimport) int WSACleanup(void);
__declspec(dllimport) int WSAGetLastError(void);
__declspec(dllimport) Socket socket(int, int, int);
__declspec(dllimport) int closesocket(Socket);
__declspec(dllimport) int bind(Socket, const void *, int);
__declspec(dllimport) int listen(Socket, int);
__declspec(dllimport) int getsockname(Socket, void *, int *);
__declspec(dllimport) int connect(Socket, const void *, int);
__declspec(dllimport) Socket accept(Socket, void *, int *);
__declspec(dllimport) int send(Socket, const char *, int, int);
__declspec(dllimport) int recv(Socket, char *, int, int);
__declspec(dllimport) int shutdown(Socket, int);
static Socket peer = ~(Socket)0, server = ~(Socket)0;
static unsigned short network(unsigned short x) { return (unsigned short)((x << 8) | (x >> 8)); }
int fixture_socket_state(void) {
  Socket value = socket(2, 1, 6);
  if (value == ~(Socket)0) return WSAGetLastError() == 10093 ? 0 : -1;
  return closesocket(value) == 0 ? 1 : -2;
}
// Zero creates a native listener; 65536 reserves an unlistened port for refusal testing.
// A port from 1 through 65535 connects the native peer to Silk's listener.
unsigned fixture_socket_prepare(unsigned port) {
  unsigned long long data[51] = {0};
  if (WSAStartup(0x202, data)) return 0;
  Socket value = socket(2, 1, 6);
  if (value == ~(Socket)0) { WSACleanup(); return 0; }
  Address address = {2, network((unsigned short)port), {127, 0, 0, 1}, {0}};
  if (port && port <= 65535) {
    if (connect(value, &address, sizeof(address))) { closesocket(value); WSACleanup(); return 0; }
    peer = value;
    return port;
  }
  int length = sizeof(address);
  if (bind(value, &address, sizeof(address)) || (port != 65536 && listen(value, 1)) || getsockname(value, &address, &length)) {
    closesocket(value); WSACleanup(); return 0;
  }
  server = value;
  return network(address.port);
}
int fixture_socket_accept(void) {
  peer = accept(server, 0, 0);
  return peer != ~(Socket)0;
}
int fixture_socket_send(void) {
  static const char payload[] = {0, 'C', (char)255, '!', '\n'};
  int at = 0;
  while (at < (int)sizeof(payload)) {
    int count = send(peer, payload + at, (int)sizeof(payload) - at, 0);
    if (count <= 0) return 0;
    at += count;
  }
  return 1;
}
int fixture_socket_receive(void) {
  static const char expected[] = {'S', 'i', 'l', 'k', 0, '!'};
  char received[6];
  int at = 0;
  while (at < (int)sizeof(received)) {
    int count = recv(peer, received + at, (int)sizeof(received) - at, 0);
    if (count <= 0) return 0;
    at += count;
  }
  for (unsigned i = 0; i < sizeof(received); ++i) if (received[i] != expected[i]) return 0;
  char tail;
  if (recv(peer, &tail, 1, 0) != 0) return 0;
  return shutdown(peer, 1) == 0;
}
int fixture_socket_finish(void) {
  int status = 0;
  if (peer != ~(Socket)0) { status |= closesocket(peer); peer = ~(Socket)0; }
  if (server != ~(Socket)0) { status |= closesocket(server); server = ~(Socket)0; }
  return (status | WSACleanup()) == 0;
}
