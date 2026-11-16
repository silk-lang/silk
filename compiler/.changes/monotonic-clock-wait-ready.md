---
bump: minor
---

`MonotonicClock.waitReady` waits for sockets, and `LocalScheduler` parks a task on it, so socket I/O in one fiber lets the others run.

## Migration

Add `waitReady(self: &mut Self, watch: &mut [ReadyWatch], until: Option<Instant>) -> usize` to each `MonotonicClock` provider; a fake clock can call `OsMonotonicClock.pollNow(&mut watch)` and then wait as `waitUntil` does. `ConnectOptions.make` and `ListenOptions.make` lost the poll interval argument, and `ReadinessWait`, `withReadinessWait`, `pollIntervalNanoseconds` and `readinessWait` are gone. A failed `poll` is now a trap.
