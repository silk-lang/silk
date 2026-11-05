---
bump: patch
---

Native sockets, TLS connections, and `NativeTransport` split into read and write halves, so one fiber reads while another writes.
