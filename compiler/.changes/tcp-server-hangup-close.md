---
bump: patch
---

`silk.net.tcp_server` closes a connection whose last bytes and end of stream arrive in one wakeup, instead of keeping it open.
