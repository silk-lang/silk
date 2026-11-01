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

`socket_native` uses pointer-sized Winsock handles, nonblocking `WSASocketW`, `WSAPoll`,
and `WSASend` for gathered writes. Each descriptor owns a scoped Winsock reference; explicit
close releases it immediately. Accepted sockets receive their own reference before the listener
can close. Created sockets prohibit inheritance and accepted sockets clear the inheritance flag.
The default bind uses `SO_EXCLUSIVEADDRUSE`; explicit reuse uses Windows `SO_REUSEADDR` semantics.
Unix-domain operations return `FamilyUnsupported`.

The actual `sockets.silk` fixture passed on Server 2025 using native Silk N2 and LLVM 22.1.8.
Its independently compiled C peer checks both client/listener directions, binary bytes, gathered
writes with partial-write completion, write shutdown and EOF, refusal on a reserved unlistened
port, and scoped/explicit Winsock cleanup. The original close implementation retained Winsock
until object drop: the same fixture exited 13 before the repair and 0 afterward. The executable
imports only Kernel32, Ntdll, and Ws2_32. Linux-target LLVM IR emission also passed.

Local evidence: `.scratch/windows-sockets-native/results.json`, `imports.txt`, and the retained
pre-fix executable. The shared cross-build and Windows runner include this fixture.
IPv6 execution, inherited-handle inspection, and the full deadline/error matrix are not checked
by this fixture. UDP remains separate work.

`WindowsRootTrustSource` reads the current user's logical `ROOT` store with Crypt32, including
machine roots exposed by that store. It opens read-only, bounds total input/DER bytes and counts,
owns every certificate in the returned snapshot, and releases both enumeration contexts and
the store on failure. A malformed certificate fails the complete load. This is an import of
certificate anchors, not a reimplementation of Windows chain policy: store properties,
disallowed-store entries, automatic root updates, and revocation are not imported.

The pinned [Zig ROOT-store implementation](https://github.com/ziglang/zig/blob/e4cbd752c8c05f131051f8c873cff7823177d7d3/lib/std/crypto/Certificate/Bundle.zig#L133)
also enumerates the logical ROOT store and copies DER. Silk additionally checks enumeration's
terminal error and owns the outstanding context during early failure. Microsoft documents that
[`CertEnumCertificatesInStore`](https://learn.microsoft.com/en-us/windows/win32/api/wincrypt/nf-wincrypt-certenumcertificatesinstore)
consumes its previous context even on failure; only `CRYPT_E_NOT_FOUND` ends this enumeration.
The [system-store provider](https://learn.microsoft.com/en-us/windows/win32/api/wincrypt/nf-wincrypt-certopenstore)
uses `CURRENT_USER | OPEN_EXISTING | READONLY`. Rust's standard library has no TLS trust provider;
the socket ownership comparison above does not establish certificate policy.

The actual `trust.silk` fixture passed against the machine's real store. Its C oracle independently
enumerates Crypt32 and checks the count and every exact DER value. It also checks the anchor limit
and that a prior snapshot remains valid after a failed load. PE imports are Kernel32, Ntdll,
and Crypt32. Local evidence is in `.scratch/windows-trust-native/`.

`NativeHttp` now uses this ROOT provider by default on Windows. An explicit PEM bundle or
`SSL_CERT_FILE` replaces it; relative environment paths resolve against the native working
directory. The same HTTP, TLS, certificate, and socket implementations handle the request.
`run-https.ps1` creates a temporary CA and a separate server certificate, without modifying any
system store, then starts an independent local OpenSSL TLS 1.3 server. The actual Silk fixture
passed an HTTP request through both an absolute Windows PEM path and relative `SSL_CERT_FILE`.
The default system roots reject that unrelated issuer with the structured `NoIssuer` reason.
An initial fixture with a CA certificate as its leaf was correctly rejected with
`InvalidBasicConstraints`; it was replaced with a correctly constrained leaf.

Local HTTPS evidence: `.scratch/windows-https-native/server/results.json`, build and server logs.
The same fixture also emits Linux LLVM IR successfully. Shared cross-build and native runners
include both trust fixtures. Windows certificate-store mutation during enumeration, forced
Crypt32 failures, and native execution of this HTTPS fixture on Linux are not checked here.
