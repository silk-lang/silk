// Probe the process's Winsock initialization through an independent socket operation.
typedef unsigned long long Socket;
__declspec(dllimport) Socket socket(int, int, int);
__declspec(dllimport) int closesocket(Socket);
__declspec(dllimport) int WSAGetLastError(void);
int fixture_winsock_active(void) {
  Socket value = socket(2, 1, 6);
  if (value == ~(Socket)0) return WSAGetLastError() == 10093 ? 0 : -1;
  return closesocket(value) == 0 ? 1 : -2;
}
