---
bump: patch
---

An idle HTTPS connection on `silk.tls.server` holds 17 KB instead of 121 KB: `Server.releaseIdle` drops the record buffers, which come back sized per record, so `Server.writePlaintext`, `closeWrite` and `requestKeyUpdate` are now effect functions.
