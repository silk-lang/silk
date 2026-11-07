---
bump: patch
---

An HTTP/1 exchange keeps its body encoder and decoder in the connection, so `withExchange` no longer copies about 1.1 KB of framing state through its frames on every request.
