---
bump: patch
---

TLS connection reads, writes and flushes, and the native HTTP transport over them, run through fewer effect frames: the transport helpers return their failure as a value, the operation guards no longer catch and re-raise, and error conversions use `Effect.mapError`.
