---
bump: patch
---

A native socket read that follows a write waits for the socket before it reads, which saves a failed read per HTTP request.
