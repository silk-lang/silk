---
bump: patch
---

`sendAll` runs each request through fewer suspendable frames: a round's worker calls the job exchange directly, and the kept-connection exchange calls `Exchange.withExchange` itself instead of through two helper functions.
