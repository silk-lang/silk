---
title: Native socket connections
description: Acquire owned or scoped TCP and pathname-Unix ByteDuplex connections with bounded cooperative polling.
---

# Native socket connections

`silk.native_socket` is the ordinary-source native transport for numeric TCP endpoints and local
pathname-Unix sockets. `connectResolvedOwned` and `connectUnixOwned` return the authoritative
affine `Connection`; their scoped counterparts consume that owner and lend it to one callback. The
module is selected only for aarch64 Apple Darwin with system libc and aarch64 or x86-64 GNU/Linux
with GNU libc. Portable, no-libc, musl, and Windows profiles do not expose it or its foreign imports.

## Open a local pathname connection

```silk
import silk.byte_duplex {ByteDuplex, ByteIoError}
import silk.effect {Effect}
import silk.monotonic_clock {MonotonicClock}
import silk.native_socket {ConnectOptions, Connection, NativeSocketError, connectUnix}
import silk.option {Option}
import silk.system_clock {Instant}

effect fn sendRequest(connection: &mut Connection) -> ()
! ByteIoError
? &mut MonotonicClock {
  let accepted = run ByteDuplex.writeSome(
    b"status\n",
    Option<Instant>.none(),
  ) |> Effect.provideMut<ByteDuplex>(&mut connection.*)
  drop accepted
  return ()
}

pub effect fn notifyLocalAgent() -> ()
! NativeSocketError | ByteIoError
? &mut MonotonicClock {
  return run connectUnix(
    b"/tmp/local-agent.sock",
    ConnectOptions.defaults(),
    Option<Instant>.none(),
    sendRequest,
  )
}
```

The callback receives a higher-ranked affine `Connection`; it cannot return the connection or keep
its `ByteDuplex` loan. Structured success, typed failure, and cancellation all run terminal release.
Use the owned constructors when another actor must retain or transfer the connection, and call
`Connection.close` when that ownership ends. Acquisition failures and structured cancellation
before publication close the descriptor once; publication transfers that responsibility to the
caller. Fatal traps remain outside structured cleanup guarantees. Unix paths are copied during
acquisition, must be absolute and NUL-free, and must fit the target `sun_path` including its
terminator (104 bytes on Darwin, 108 on GNU). The transport never creates, removes, or owns the
filesystem pathname.

## Deadlines, polling, and throughput

`ConnectOptions.defaults()` retains Nagle, permits 64 counted attempts, and checks readiness every
one millisecond. `ConnectOptions.make` admits intervals from 1 through 1,000,000,000 nanoseconds and
attempt counts from 1 through 1024. `connectResolved` receives already-resolved numeric endpoints;
DNS is deliberately outside its deadline. One supplied absolute deadline covers setup and every
candidate without renewal. `Option<Instant>.none()` permits a pending operation to wait indefinitely,
subject to the active `MonotonicClock` provider.

Readiness uses zero-time `poll` followed by a positive clock wait, so a local scheduler can run peer
tasks and cancel its timer before the socket finalizer. The interval therefore trades latency for a
bounded idle poll rate; this first provider is not an event reactor and does not promise
high-connection-count throughput.

## Transfer and error boundaries

Reads and writes acknowledge only an exact positive prefix. A zero-byte receive is sticky end of
input; hangup does not discard already-readable bytes. `flush` is intentionally a no-op: a successful
send means kernel acceptance, not peer delivery. `shutdownWrite` flushes that boundary, issues one
directional shutdown, remains readable, and is idempotent.

Acquisition reports rich `NativeSocketError` values for invalid input, deadline arithmetic, timeout,
attempt exhaustion, policy failures, and the responsible native operation/errno. Once installed as
`ByteDuplex`, timeout, invalid count, and closure use the canonical `ByteIoError` variants; other
native failures retain the exact `ByteIoOperation` and errno as `Provider.code`. A checked wake-time
overflow during byte I/O uses provider code `-1`, because `ByteIoError` has no time-range variant.
