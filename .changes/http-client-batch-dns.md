---
bump: patch
---

`sendAll` resolves each host once per batch instead of once for each new connection. The system lookup blocks the thread, so before, a batch that opened 64 connections to one host made 64 lookups one after another, and every worker waited on each one. The new `ExchangeNative.acquireResolvedOwned` opens a connection to endpoints that you already resolved.
