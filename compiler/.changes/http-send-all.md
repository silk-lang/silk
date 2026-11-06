---
bump: minor
---

`Http.sendAll` sends a list of requests and returns their results in order; `NativeHttp` runs up to 32 at once on one thread (`withConcurrency`) and keeps up to 64 idle connections.

## Migration

Add `sendAll` to each `Http` provider; one that sends one at a time returns `run Http.sendEach(move requests) |> Effect.provideMut<Http>(&mut self.*)`.
