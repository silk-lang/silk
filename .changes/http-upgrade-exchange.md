---
bump: patch
---

`silk.http.exchange` handles a 101 answer to an upgrade request (`HeaderPolicy.upgrade`), and `intoUpgraded` returns the transport with the bytes after the head; `Origin.fromUri` accepts `ws` and `wss`.
