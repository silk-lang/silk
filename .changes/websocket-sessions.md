---
bump: patch
---

`silk.http.websocket_stream` replaces `silk.http.websocket_server`: one session type for clients and servers over any `HttpTransport`, with fragments, and a split form where the reader answers Ping and Close for the writers.
