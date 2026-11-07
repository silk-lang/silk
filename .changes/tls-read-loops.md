---
bump: patch
---

TLS connections read with loops instead of recursive suspendable calls, so a read that needs more records no longer goes back through the scheduler's driver and pushes a new frame for each one. `drainOutput` runs only when output waits. In `sendAll`, a job sets up the connect options only when it opens a new connection.
