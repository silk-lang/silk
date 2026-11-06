---
bump: patch
---

The native HTTP client opens a new connection outside the frame of each request, which no longer reserves the connection's 16 KB there.
