---
bump: minor
---

Add nonblocking calls to `silk.net.socket_native`: `startConnect`, `startConnectUnix`, `Connection.finishConnect`, `tryRead`, `tryWrite`, `tryWriteVectored`, `Listener.tryAccept`, `shutdownWrite`, `setNoDelay`, `setKeepAlive`, `localEndpoint`, `peerEndpoint`, and `rawDescriptor` for readiness loops.
