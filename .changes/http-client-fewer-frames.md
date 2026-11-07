---
bump: patch
---

`sendAll` runs each request through fewer suspendable frames: a round's worker calls the job exchange directly, and the kept-connection exchange calls `Exchange.withExchange` itself instead of through two helper functions. The trust source wraps only the connect of a new connection, not every exchange. A round job runs its exchange in its own frame and returns the failure, instead of wrapping `exchangeKept` in a result.
