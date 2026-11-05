---
bump: patch
---

WebSocket clients: `handshake` of `silk.http.websocket_client` and `connect` of `silk.http.websocket_native` open `ws` and `wss` sessions, with masked frames from the shared codec in `silk.http.websocket`.
