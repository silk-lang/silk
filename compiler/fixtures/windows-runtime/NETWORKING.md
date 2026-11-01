# Windows networking evidence

`NativeSystemResolver` uses `GetAddrInfoW` for the existing validated ASCII domain representation.
The Win64 `ADDRINFOW.ai_addrlen` is `usize`; the canonical-name pointer precedes the address pointer.
Windows AF_INET6 is 23 and AI_NUMERICSERV is 8. Returned lists are freed before the provider drops
its Winsock reference. The existing result limit, family filtering, deduplication, and refusal of
blocking DNS deadlines are unchanged.

References inspected:

- [Rust 1.90 Windows sockets](https://github.com/rust-lang/rust/blob/1159e78c4747b02ef996e55082b704c09b970588/library/std/src/sys/net/connection/socket/windows.rs):
  requests Winsock 2.2, balances competing startup calls, and reads WSA errors rather than errno.
  Silk owns one reference per live operation instead of Rust's process-global initialization.
- [Zig 0.15.2 Winsock declarations](https://github.com/ziglang/zig/blob/e4cbd752c8c05f131051f8c873cff7823177d7d3/lib/std/os/windows/ws2_32.zig):
  pointer-sized address length, wide SOCKET, Win64 WSADATA layout and native error constants.
- [Microsoft GetAddrInfoW](https://learn.microsoft.com/en-us/windows/win32/api/ws2tcpip/nf-ws2tcpip-getaddrinfow):
  paired FreeAddrInfoW ownership and direct WSA/EAI return codes.

The dedicated `resolver.silk` fixture resolves localhost through the real provider, checks IPv4
loopback results and port 43123, checks explicit deadline refusal, and nests the lookup inside a
separate Winsock owner. The independently compiled C companion probes initialization by creating
and closing a socket: no reference may leak after a lookup, and a nested lookup must not release
the caller's reference. It does not implement DNS or supply resolver results.

The actual Silk fixture was built by the first native Windows compiler generation and passed on
Server 2025 with LLVM 22.1.8 (exit 0). This includes native localhost results, family/port checks,
deadline refusal, no leaked Winsock reference, and preservation of an enclosing reference.
The shared Windows cross-build and native runner include this fixture; no external DNS is needed.
TCP/UDP socket providers and the Windows certificate store remain separate unfinished work.
